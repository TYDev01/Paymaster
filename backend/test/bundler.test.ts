import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {encodeFunctionData, parseAbi, parseEther, toHex, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";

import {calculateMaxCost} from "../src/chain/gas.js";
import {packUint128Pair, type PackedUserOperation} from "../src/domain/userOperation.js";
import {SignatureEngine} from "../src/signature/signatureEngine.js";
import {LocalSponsorshipSigner} from "../src/signature/signer.js";
import {deploy, loadArtifact, startAnvil, type AnvilInstance} from "./support/anvil.js";
import {bundlerRpc, rundlerAvailable, startBundler, type BundlerInstance} from "./support/bundler.js";

/**
 * The paymaster against a REAL bundler.
 *
 * Every other test in this suite calls `handleOps` directly, which is not what a bundler does. A
 * bundler simulates the operation with tracing, enforces the ERC-7562 storage-access rules, admits
 * the op to a mempool, and builds a bundle. A paymaster can pass every direct-`handleOps` test and
 * still be rejected by every bundler in production — most commonly for touching storage during
 * validation without being staked, which is exactly what this paymaster does.
 *
 * Rundler is run in SAFE mode (no `--unsafe`), because unsafe mode skips the very validation this
 * file exists to exercise.
 */
const describeBundler = rundlerAvailable() ? describe : describe.skip;

describeBundler("paymaster <-> rundler (real bundler)", () => {
  let anvil: AnvilInstance;
  let bundler: BundlerInstance;
  let entryPoint: Address;
  let paymaster: Address;
  let unstakedPaymaster: Address;
  let account: Address;
  let chainId: number;
  let entryPointAbi: ReturnType<typeof loadArtifact>["abi"];

  const signerKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
  const signer = privateKeyToAccount(signerKey);
  const accountOwnerKey = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;
  const accountOwner = privateKeyToAccount(accountOwnerKey);
  const builderKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

  const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;

  const VERIFICATION_GAS = 500_000n;
  const CALL_GAS = 200_000n;
  const PM_VERIFICATION_GAS = 300_000n;
  const POSTOP_GAS = 50_000n;
  const PRE_VERIFICATION_GAS = 100_000n;

  const engine = new SignatureEngine(new LocalSponsorshipSigner(signerKey));

  beforeAll(async () => {
    anvil = await startAnvil();
    chainId = await anvil.publicClient.getChainId();

    // Rundler reads fee data through Multicall3 and anvil does not predeploy it. Multicall3 has no
    // constructor args and no immutables, so injecting its mainnet runtime code is exact.
    const multicall3Code = await fetchMulticall3Code();
    await anvil.publicClient.request({
      method: "anvil_setCode" as never,
      params: [MULTICALL3, multicall3Code] as never,
    });

    const entryPointArtifact = loadArtifact("EntryPoint.sol", "EntryPoint");
    entryPointAbi = entryPointArtifact.abi;
    entryPoint = await deploy(anvil, entryPointArtifact);

    const factory = await deploy(anvil, loadArtifact("SimpleAccountFactory.sol", "SimpleAccountFactory"), [entryPoint]);
    const factoryAbi = parseAbi([
      "function createAccount(address owner, uint256 salt) returns (address)",
      "function getAddress(address owner, uint256 salt) view returns (address)",
    ]);
    account = await anvil.publicClient.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "getAddress",
      args: [accountOwner.address, 0n],
    });
    await anvil.publicClient.waitForTransactionReceipt({
      hash: await anvil.walletClient.writeContract({
        address: factory,
        abi: factoryAbi,
        functionName: "createAccount",
        args: [accountOwner.address, 0n],
        account: anvil.walletClient.account!,
        chain: anvil.walletClient.chain!,
      }),
    });

    const pmArtifact = loadArtifact("VerifyingPaymaster.sol", "VerifyingPaymaster");
    paymaster = await deploy(anvil, pmArtifact, [entryPoint, anvil.deployer, signer.address]);
    unstakedPaymaster = await deploy(anvil, pmArtifact, [entryPoint, anvil.deployer, signer.address]);

    const send = async (address: Address, fn: string, args: unknown[], value: bigint) =>
      anvil.publicClient.waitForTransactionReceipt({
        hash: await anvil.walletClient.writeContract({
          address,
          abi: pmArtifact.abi,
          functionName: fn,
          args: args as never,
          value,
          account: anvil.walletClient.account!,
          chain: anvil.walletClient.chain!,
        }),
      });

    await send(paymaster, "deposit", [], parseEther("10"));
    await send(paymaster, "addStake", [86_400], parseEther("1"));

    // Funded but deliberately NOT staked, to show what a bundler does with it.
    await send(unstakedPaymaster, "deposit", [], parseEther("10"));

    bundler = await startBundler({
      nodeHttp: anvil.rpcUrl,
      entryPoint,
      chainId,
      builderKey,
    });
  }, 180_000);

  afterAll(() => {
    bundler?.stop();
    anvil?.stop();
  });

  async function currentNonce(): Promise<bigint> {
    return (await anvil.publicClient.readContract({
      address: entryPoint,
      abi: entryPointAbi,
      functionName: "getNonce",
      args: [account, 0n],
    })) as bigint;
  }

  const CALL_DATA = encodeFunctionData({
    abi: parseAbi(["function execute(address dest, uint256 value, bytes func)"]),
    functionName: "execute",
    args: ["0x000000000000000000000000000000000000dEaD", 0n, "0x"],
  });

  /** Builds a fully sponsored, fully signed operation, as our API + a wallet would produce it. */
  async function buildSponsoredOp(pm: Address, nonce: bigint, maxFee: bigint) {
    const base: PackedUserOperation = {
      sender: account,
      nonce,
      initCode: "0x",
      callData: CALL_DATA,
      accountGasLimits: toHex(packUint128Pair(VERIFICATION_GAS, CALL_GAS), {size: 32}),
      preVerificationGas: PRE_VERIFICATION_GAS,
      gasFees: toHex(packUint128Pair(1_000_000_000n, maxFee), {size: 32}),
      paymasterAndData: "0x",
      signature: "0x",
    };

    const attestation = await engine.attest({
      userOp: base,
      chainId,
      paymaster: pm,
      paymasterVerificationGasLimit: PM_VERIFICATION_GAS,
      postOpGasLimit: POSTOP_GAS,
      validUntil: Math.floor(Date.now() / 1000) + 3_600,
      validAfter: 0,
    });

    const sponsored = {...base, paymasterAndData: attestation.paymasterAndData};
    const userOpHash = (await anvil.publicClient.readContract({
      address: entryPoint,
      abi: entryPointAbi,
      functionName: "getUserOpHash",
      args: [sponsored],
    })) as Hex;

    const signature = await accountOwner.signMessage({message: {raw: userOpHash}});

    return {
      userOpHash,
      maxCost: calculateMaxCost({
        userOp: sponsored,
        paymasterVerificationGasLimit: PM_VERIFICATION_GAS,
        postOpGasLimit: POSTOP_GAS,
      }),
      /** The UNPACKED v0.7 shape, which is what eth_sendUserOperation takes. */
      rpcOp: {
        sender: account,
        nonce: toHex(nonce),
        callData: CALL_DATA,
        callGasLimit: toHex(CALL_GAS),
        verificationGasLimit: toHex(VERIFICATION_GAS),
        preVerificationGas: toHex(PRE_VERIFICATION_GAS),
        maxFeePerGas: toHex(maxFee),
        maxPriorityFeePerGas: toHex(1_000_000_000n),
        paymaster: pm,
        paymasterVerificationGasLimit: toHex(PM_VERIFICATION_GAS),
        paymasterPostOpGasLimit: toHex(POSTOP_GAS),
        // Just the paymaster-specific tail: the RPC shape splits out the address and gas limits.
        paymasterData: `0x${attestation.paymasterAndData.slice(2 + 52 * 2)}` as Hex,
        signature,
      },
    };
  }

  /** Current base fee, doubled — a bundler rejects an op it cannot profitably include. */
  async function viableMaxFee(): Promise<bigint> {
    const block = await anvil.publicClient.getBlock();
    return (block.baseFeePerGas ?? 1_000_000_000n) * 2n + 1_000_000_000n;
  }

  it("the bundler is live and reports our EntryPoint", async () => {
    const {result} = await bundlerRpc<string[]>(bundler.rpcUrl, "eth_supportedEntryPoints", []);
    expect(result?.map((e) => e.toLowerCase())).toContain(entryPoint.toLowerCase());
  });

  /**
   * The claim this whole file exists to test: a real bundler, running full trace-based validation,
   * accepts our sponsorship and lands it on-chain.
   */
  it("accepts a sponsored operation and bundles it on-chain", async () => {
    const {rpcOp, userOpHash} = await buildSponsoredOp(paymaster, await currentNonce(), await viableMaxFee());

    const send = await bundlerRpc<Hex>(bundler.rpcUrl, "eth_sendUserOperation", [rpcOp, entryPoint]);
    expect(send.error, `bundler rejected the op: ${JSON.stringify(send.error)}\n${bundler.logs()}`).toBeUndefined();
    expect(send.result?.toLowerCase()).toBe(userOpHash.toLowerCase());

    // The builder mines on its own schedule; poll rather than assume.
    const receipt = await waitForUserOpReceipt(bundler.rpcUrl, userOpHash);
    expect(receipt, `no receipt within timeout.\n${bundler.logs()}`).toBeDefined();
    expect(receipt.success).toBe(true);
  }, 90_000);

  it("the account paid nothing; the paymaster's deposit did", async () => {
    const before = (await anvil.publicClient.readContract({
      address: entryPoint,
      abi: entryPointAbi,
      functionName: "balanceOf",
      args: [paymaster],
    })) as bigint;
    expect(await anvil.publicClient.getBalance({address: account})).toBe(0n);

    const {rpcOp, userOpHash} = await buildSponsoredOp(paymaster, await currentNonce(), await viableMaxFee());
    await bundlerRpc(bundler.rpcUrl, "eth_sendUserOperation", [rpcOp, entryPoint]);
    await waitForUserOpReceipt(bundler.rpcUrl, userOpHash);

    const after = (await anvil.publicClient.readContract({
      address: entryPoint,
      abi: entryPointAbi,
      functionName: "balanceOf",
      args: [paymaster],
    })) as bigint;

    expect(after, "the paymaster deposit must have funded the operation").toBeLessThan(before);
    expect(await anvil.publicClient.getBalance({address: account}), "the account must still hold nothing").toBe(0n);
  }, 90_000);

  /**
   * Why stake is not optional.
   *
   * This paymaster reads its own storage during validation (the signer set and the pause flag).
   * ERC-7562 permits that only for a STAKED paymaster. An unstaked deployment does not fail
   * loudly at deploy time or in any direct-handleOps test — it fails here, at the bundler, which
   * is the first place anyone would notice in production.
   */
  it("rejects the same sponsorship from an UNSTAKED paymaster", async () => {
    const {rpcOp} = await buildSponsoredOp(unstakedPaymaster, await currentNonce(), await viableMaxFee());
    const send = await bundlerRpc<Hex>(bundler.rpcUrl, "eth_sendUserOperation", [rpcOp, entryPoint]);

    expect(send.error, "an unstaked paymaster touching its own storage must be rejected").toBeDefined();
    // ERC-7562 rejections surface as -32502 (banned opcode/storage) or -32505 (stake too low).
    expect([-32502, -32505]).toContain(send.error?.code);
  }, 60_000);

  /**
   * A forged PAYMASTER signature, with a valid account signature over it.
   *
   * The account signature must be recomputed after tampering. Without that, altering
   * paymasterData changes the userOpHash, the ACCOUNT's signature breaks first, and the bundler
   * rejects with "Invalid account signature" — never reaching the paymaster's signature check at
   * all. That rejection looks like a pass and tests nothing about the paymaster.
   */
  it("rejects a forged paymaster signature (with a valid account signature)", async () => {
    const nonce = await currentNonce();
    const maxFee = await viableMaxFee();
    const {rpcOp} = await buildSponsoredOp(paymaster, nonce, maxFee);

    // Flip the last byte of the paymaster's signature tail.
    const forgedData = (rpcOp.paymasterData.slice(0, -2) +
      (rpcOp.paymasterData.endsWith("00") ? "01" : "00")) as Hex;

    // Re-sign the account over the tampered operation, so the ONLY invalid thing is ours.
    const forgedPacked: PackedUserOperation = {
      sender: account,
      nonce,
      initCode: "0x",
      callData: CALL_DATA,
      accountGasLimits: toHex(packUint128Pair(VERIFICATION_GAS, CALL_GAS), {size: 32}),
      preVerificationGas: PRE_VERIFICATION_GAS,
      gasFees: toHex(packUint128Pair(1_000_000_000n, maxFee), {size: 32}),
      paymasterAndData: `${paymaster}${toHex(PM_VERIFICATION_GAS, {size: 16}).slice(2)}${toHex(POSTOP_GAS, {size: 16}).slice(2)}${forgedData.slice(2)}` as Hex,
      signature: "0x",
    };
    const forgedHash = (await anvil.publicClient.readContract({
      address: entryPoint,
      abi: entryPointAbi,
      functionName: "getUserOpHash",
      args: [forgedPacked],
    })) as Hex;

    const send = await bundlerRpc<Hex>(bundler.rpcUrl, "eth_sendUserOperation", [
      {
        ...rpcOp,
        paymasterData: forgedData,
        signature: await accountOwner.signMessage({message: {raw: forgedHash}}),
      },
      entryPoint,
    ]);

    expect(send.error, "a forged paymaster signature must not enter the mempool").toBeDefined();
    // -32507 is signature failure. It must now be OURS failing, not the account's: the account
    // signature is valid over exactly these bytes.
    expect(send.error?.message, `unexpected rejection: ${JSON.stringify(send.error)}`).not.toContain(
      "account signature",
    );
  }, 60_000);

  it("estimates gas through the bundler", async () => {
    const {rpcOp} = await buildSponsoredOp(paymaster, await currentNonce(), await viableMaxFee());
    const {sender, nonce, callData, paymaster: pm, paymasterData, paymasterVerificationGasLimit, paymasterPostOpGasLimit, signature} = rpcOp;

    const estimate = await bundlerRpc<Record<string, Hex>>(bundler.rpcUrl, "eth_estimateUserOperationGas", [
      {sender, nonce, callData, paymaster: pm, paymasterData, paymasterVerificationGasLimit, paymasterPostOpGasLimit, signature},
      entryPoint,
    ]);

    expect(estimate.error, JSON.stringify(estimate.error)).toBeUndefined();
    expect(BigInt(estimate.result!["verificationGasLimit"]!)).toBeGreaterThan(0n);
  }, 60_000);

  it("exposes Prometheus metrics, as td2.md requires", async () => {
    const text = await (await fetch(bundler.metricsUrl)).text();
    expect(text).toContain("rundler_");
  });
});

async function waitForUserOpReceipt(rpcUrl: string, userOpHash: Hex): Promise<{success: boolean}> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const {result} = await bundlerRpc<{success: boolean} | null>(rpcUrl, "eth_getUserOperationReceipt", [userOpHash]);
    if (result != null) return result;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no UserOperation receipt for ${userOpHash} within 60s`);
}

/** Multicall3's runtime code, cached next to the bundler binary to avoid a network call per run. */
async function fetchMulticall3Code(): Promise<Hex> {
  const {readFile, writeFile, mkdir} = await import("node:fs/promises");
  const {dirname: dir, resolve: res} = await import("node:path");
  const {fileURLToPath: toPath} = await import("node:url");
  const cache = res(dir(toPath(import.meta.url)), "../.bundler/multicall3.hex");

  try {
    return (await readFile(cache, "utf8")).trim() as Hex;
  } catch {
    const response = await fetch("https://ethereum-rpc.publicnode.com", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getCode",
        params: ["0xcA11bde05977b3631167028862bE2a173976CA11", "latest"],
      }),
    });
    const {result} = (await response.json()) as {result: Hex};
    await mkdir(dir(cache), {recursive: true});
    await writeFile(cache, result);
    return result;
  }
}
