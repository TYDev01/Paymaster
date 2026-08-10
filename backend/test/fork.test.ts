import "reflect-metadata";

import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {encodeFunctionData, parseAbi, parseEther, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";

import {ChainRegistry} from "../src/chain/chainRegistry.js";
import type {ChainConfig} from "../src/chain/chainConfig.js";
import {calculateMaxCost} from "../src/chain/gas.js";
import {toPackedUserOperation} from "../src/api/dto/sponsorRequest.js";
import {SignatureEngine} from "../src/signature/signatureEngine.js";
import {LocalSponsorshipSigner} from "../src/signature/signer.js";
import {deploy, loadArtifact, startAnvil, type AnvilInstance} from "./support/anvil.js";

/**
 * The paymaster against a FORK of a live chain.
 *
 * Every other test builds its world from scratch on a fresh anvil: our EntryPoint, our factory, our
 * accounts. That proves the logic is right; it cannot prove the assumptions about the real chain
 * are. This one forks mainnet at the head, so the EntryPoint is the REAL deployment at its real
 * canonical address, with the bytecode everyone else's bundlers validate against, alongside real
 * base fees and a real deposit ledger that other paymasters are already using.
 *
 * Three assumptions the rest of the suite takes on faith and this one actually checks:
 *
 *   1. `0x0000000071727De22E5E9d8BAf0edAc6f37da032` really is EntryPoint v0.7 on mainnet, and the
 *      code there behaves as the vendored copy does. The whole "chain onboarding is configuration
 *      only" claim rests on this address being canonical and identical everywhere.
 *   2. Our paymaster deposits into, and stakes with, that real contract — not just our local copy.
 *   3. Validation of a signed sponsorship succeeds against real state, at a real base fee, with
 *      `validatePaymasterUserOp` invoked by the real EntryPoint through `handleOps`.
 *
 * Opt-in via FORK_RPC_URL, because it needs an external endpoint and takes tens of seconds. It
 * SKIPS rather than fails when unset — but note that a skipped test proves nothing, which is why
 * the default endpoint below is a public one that works without an API key.
 */
const FORK_RPC_URL = process.env["FORK_RPC_URL"] ?? "https://ethereum-rpc.publicnode.com";
const FORK_ENABLED = process.env["FORK_TESTS"] !== "false";

const CANONICAL_ENTRYPOINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;

describe.skipIf(!FORK_ENABLED)("forked mainnet", () => {
  let anvil: AnvilInstance;
  let reachable = false;
  let paymaster: Address;
  let account: Address;
  let chainId: number;

  const signerKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
  const signer = privateKeyToAccount(signerKey);
  const accountOwnerKey = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;
  const accountOwner = privateKeyToAccount(accountOwnerKey);

  const entryPointAbi = loadArtifact("EntryPoint.sol", "EntryPoint").abi;
  const paymasterArtifact = loadArtifact("VerifyingPaymaster.sol", "VerifyingPaymaster");

  beforeAll(async () => {
    try {
      anvil = await startAnvil({forkUrl: FORK_RPC_URL});
      reachable = true;
    } catch {
      // A public endpoint that is rate-limited or down is not a defect in this repository.
      return;
    }

    chainId = await anvil.publicClient.getChainId();

    // The account factory is ours (mainnet has no SimpleAccountFactory we can rely on), but it is
    // wired to the REAL EntryPoint — which is the point.
    const factory = await deploy(anvil, loadArtifact("SimpleAccountFactory.sol", "SimpleAccountFactory"), [
      CANONICAL_ENTRYPOINT,
    ]);
    const factoryAbi = parseAbi([
      "function createAccount(address owner, uint256 salt) returns (address)",
      "function getAddress(address owner, uint256 salt) view returns (address)",
    ]);
    account = (await anvil.publicClient.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "getAddress",
      args: [accountOwner.address, 0n],
    })) as Address;
    await anvil.publicClient.waitForTransactionReceipt({
      hash: await anvil.walletClient.writeContract({
        address: factory,
        abi: factoryAbi,
        functionName: "createAccount",
        args: [accountOwner.address, 0n],
        account: anvil.walletClient.account!,
        chain: anvil.chain,
      }),
    });

    paymaster = await deploy(anvil, paymasterArtifact, [CANONICAL_ENTRYPOINT, anvil.deployer, signer.address]);

    for (const call of [
      {functionName: "deposit", args: [] as unknown[], value: parseEther("2")},
      {functionName: "addStake", args: [86_400], value: parseEther("1")},
    ]) {
      await anvil.publicClient.waitForTransactionReceipt({
        hash: await anvil.walletClient.writeContract({
          address: paymaster,
          abi: paymasterArtifact.abi,
          functionName: call.functionName,
          args: call.args as never,
          value: call.value,
          account: anvil.walletClient.account!,
          chain: anvil.chain,
        }),
      });
    }
  }, 180_000);

  afterAll(() => {
    anvil?.stop();
  });

  it("finds the canonical EntryPoint v0.7 already deployed on the real chain", async () => {
    expect(reachable, "fork RPC unreachable — this assertion was not exercised").toBe(true);

    const code = await anvil.publicClient.getCode({address: CANONICAL_ENTRYPOINT});
    expect(code, "no EntryPoint at the canonical address on mainnet").toBeDefined();
    expect((code ?? "0x").length).toBeGreaterThan(2);

    /**
     * Bytecode equality against the vendored copy is deliberately NOT asserted: it would fail for
     * reasons that say nothing about compatibility. v0.7's EntryPoint deploys a `SenderCreator` in
     * its constructor and holds it as an immutable, so the address of OUR local deployment is baked
     * into our runtime code and differs from the deployed one; the solc metadata hash differs too.
     *
     * What actually matters for "chain onboarding is configuration only" is that the deployed
     * contract answers the v0.7 interface this service depends on. That is what is checked here,
     * and the sponsorship test below then exercises it for real.
     */
    const nonce = await anvil.publicClient.readContract({
      address: CANONICAL_ENTRYPOINT,
      abi: entryPointAbi,
      functionName: "getNonce",
      args: [account, 0n],
    });
    expect(nonce, "the deployed EntryPoint does not answer getNonce as v0.7 does").toBe(0n);
  });

  it("registers our deposit and stake on the real EntryPoint's ledger", async () => {
    expect(reachable, "fork RPC unreachable — this assertion was not exercised").toBe(true);

    const info = (await anvil.publicClient.readContract({
      address: CANONICAL_ENTRYPOINT,
      abi: entryPointAbi,
      functionName: "getDepositInfo",
      args: [paymaster],
    })) as {deposit: bigint; staked: boolean; stake: bigint; unstakeDelaySec: number};

    expect(info.deposit).toBe(parseEther("2"));
    expect(info.staked, "an unstaked paymaster is rejected by every conforming bundler").toBe(true);
    expect(info.stake).toBe(parseEther("1"));
  });

  it("sponsors a UserOperation executed by the real EntryPoint, at a real base fee", async () => {
    expect(reachable, "fork RPC unreachable — this assertion was not exercised").toBe(true);

    // Real fee data from the forked chain, not invented numbers: this is the one place where the
    // gas maths meets prices we did not choose.
    const block = await anvil.publicClient.getBlock();
    const baseFee = block.baseFeePerGas ?? 1_000_000_000n;
    const maxPriorityFeePerGas = 1_000_000_000n;
    const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;

    const chainConfig: ChainConfig = {
      chainId,
      name: "mainnet-fork",
      rpcUrls: [anvil.rpcUrl],
      entryPoint: CANONICAL_ENTRYPOINT,
      paymaster,
      explorerUrl: "https://etherscan.io",
      nativeCurrency: {symbol: "ETH", decimals: 18},
      minDepositWei: parseEther("1"),
      minStakeWei: parseEther("1"),
      enabled: true,
    };
    // Passing the real EntryPoint address through the registry's own verification is itself a check:
    // it asserts the chain serves the id it claims and the EntryPoint has code.
    const chains = ChainRegistry.fromConfigs([chainConfig]);
    await chains.verifyAll();

    const callData = encodeFunctionData({
      abi: parseAbi(["function execute(address dest, uint256 value, bytes func)"]),
      functionName: "execute",
      args: ["0x000000000000000000000000000000000000dEaD", 0n, "0x"],
    });

    const request = {
      sender: account,
      nonce: 0n,
      callData,
      callGasLimit: 200_000n,
      verificationGasLimit: 500_000n,
      preVerificationGas: 100_000n,
      maxFeePerGas,
      maxPriorityFeePerGas,
    };

    // The already-validated shape (bigints), which is what the service passes on from the DTO.
    const userOp = toPackedUserOperation({...request, factory: undefined, factoryData: undefined, signature: "0x"});

    const paymasterVerificationGasLimit = 300_000n;
    const postOpGasLimit = 50_000n;
    const maxCost = calculateMaxCost({userOp, paymasterVerificationGasLimit, postOpGasLimit});
    expect(maxCost, "worst-case cost must be positive at a real base fee").toBeGreaterThan(0n);

    const attestation = await new SignatureEngine(new LocalSponsorshipSigner(signerKey)).attest({
      userOp,
      chainId,
      paymaster,
      paymasterVerificationGasLimit,
      postOpGasLimit,
      validUntil: Math.floor(Date.now() / 1000) + 300,
      validAfter: 0,
    });

    const signedOp = {...userOp, paymasterAndData: attestation.paymasterAndData};
    const userOpHash = (await anvil.publicClient.readContract({
      address: CANONICAL_ENTRYPOINT,
      abi: entryPointAbi,
      functionName: "getUserOpHash",
      args: [signedOp],
    })) as Hex;

    const accountSignature = await accountOwner.signMessage({message: {raw: userOpHash}});

    const beneficiary = "0x000000000000000000000000000000000000bEEF" as Address;
    const depositBefore = (await anvil.publicClient.readContract({
      address: CANONICAL_ENTRYPOINT,
      abi: entryPointAbi,
      functionName: "balanceOf",
      args: [paymaster],
    })) as bigint;
    const accountBalanceBefore = await anvil.publicClient.getBalance({address: account});

    const receipt = await anvil.publicClient.waitForTransactionReceipt({
      hash: await anvil.walletClient.writeContract({
        address: CANONICAL_ENTRYPOINT,
        abi: entryPointAbi,
        functionName: "handleOps",
        args: [[{...signedOp, signature: accountSignature}], beneficiary],
        account: anvil.walletClient.account!,
        chain: anvil.chain,
      }),
    });

    expect(receipt.status, "the real EntryPoint rejected our sponsored operation").toBe("success");

    const depositAfter = (await anvil.publicClient.readContract({
      address: CANONICAL_ENTRYPOINT,
      abi: entryPointAbi,
      functionName: "balanceOf",
      args: [paymaster],
    })) as bigint;

    // The whole promise of the product, asserted against the real contract: the paymaster's deposit
    // paid, and the account's balance is untouched.
    expect(depositAfter, "the paymaster's deposit did not pay").toBeLessThan(depositBefore);
    expect(await anvil.publicClient.getBalance({address: account})).toBe(accountBalanceBefore);
    // And what was actually spent must be within what we committed to.
    expect(depositBefore - depositAfter, "real cost exceeded the worst case we reserved").toBeLessThanOrEqual(maxCost);
  }, 120_000);
});
