import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {encodeFunctionData, keccak256, parseAbi, parseEther, toHex, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";

import {packUint128Pair, type PackedUserOperation} from "../src/domain/userOperation.js";
import {calculateMaxCost} from "../src/chain/gas.js";
import {SignatureEngine} from "../src/signature/signatureEngine.js";
import {LocalSponsorshipSigner} from "../src/signature/signer.js";
import {deploy, loadArtifact, startAnvil, type AnvilInstance} from "./support/anvil.js";

/**
 * Pins `calculateMaxCost` to the EntryPoint's real behaviour.
 *
 * `_getRequiredPrefund` is internal, so rather than read the number out of the contract we assert
 * the property that actually matters operationally: fund the paymaster with exactly our computed
 * maxCost and the operation goes through; fund it one wei less and the EntryPoint refuses with
 * AA31. That brackets the formula from both sides — a formula that is too low fails the first
 * assertion, one that is too high fails the second.
 *
 * This is also the first full end-to-end proof that an operation sponsored by a signature our
 * TypeScript produced is executed by a real EntryPoint.
 */
describe("maxCost <-> EntryPoint requiredPrefund", () => {
  let anvil: AnvilInstance;
  let entryPoint: Address;
  let paymaster: Address;
  let account: Address;
  let entryPointAbi: ReturnType<typeof loadArtifact>["abi"];

  const signerKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
  const signer = privateKeyToAccount(signerKey);
  const accountOwnerKey = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;
  const accountOwner = privateKeyToAccount(accountOwnerKey);

  const VERIFICATION_GAS = 500_000n;
  const CALL_GAS = 200_000n;
  const PM_VERIFICATION_GAS = 300_000n;
  const POSTOP_GAS = 50_000n;
  const PRE_VERIFICATION_GAS = 100_000n;
  const MAX_FEE = 20_000_000_000n;
  const MAX_PRIORITY_FEE = 1_000_000_000n;

  const engine = new SignatureEngine(new LocalSponsorshipSigner(signerKey));

  beforeAll(async () => {
    anvil = await startAnvil();

    const entryPointArtifact = loadArtifact("EntryPoint.sol", "EntryPoint");
    entryPointAbi = entryPointArtifact.abi;
    entryPoint = await deploy(anvil, entryPointArtifact);

    const factory = await deploy(anvil, loadArtifact("SimpleAccountFactory.sol", "SimpleAccountFactory"), [entryPoint]);

    // Deploy a real account rather than using an undeployed counterfactual: this test is about
    // prefund arithmetic, and initCode would add account-creation gas to the total.
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
    const createHash = await anvil.walletClient.writeContract({
      address: factory,
      abi: factoryAbi,
      functionName: "createAccount",
      args: [accountOwner.address, 0n],
      account: anvil.walletClient.account!,
      chain: anvil.walletClient.chain!,
    });
    await anvil.publicClient.waitForTransactionReceipt({hash: createHash});

    paymaster = await deploy(anvil, loadArtifact("VerifyingPaymaster.sol", "VerifyingPaymaster"), [
      entryPoint,
      anvil.deployer,
      signer.address,
    ]);

    // Stake is mandatory: the paymaster reads its own storage during validation.
    await anvil.publicClient.waitForTransactionReceipt({
      hash: await anvil.walletClient.writeContract({
        address: paymaster,
        abi: loadArtifact("VerifyingPaymaster.sol", "VerifyingPaymaster").abi,
        functionName: "addStake",
        args: [86_400],
        value: parseEther("1"),
        account: anvil.walletClient.account!,
        chain: anvil.walletClient.chain!,
      }),
    });
  }, 90_000);

  afterAll(() => anvil?.stop());

  function baseOp(): PackedUserOperation {
    return {
      sender: account,
      nonce: 0n,
      initCode: "0x",
      callData: encodeFunctionData({
        abi: parseAbi(["function execute(address dest, uint256 value, bytes func)"]),
        functionName: "execute",
        args: ["0x000000000000000000000000000000000000dEaD", 0n, "0x"],
      }),
      accountGasLimits: toHex(packUint128Pair(VERIFICATION_GAS, CALL_GAS), {size: 32}),
      preVerificationGas: PRE_VERIFICATION_GAS,
      gasFees: toHex(packUint128Pair(MAX_PRIORITY_FEE, MAX_FEE), {size: 32}),
      paymasterAndData: "0x",
      signature: "0x",
    };
  }

  /** Builds a fully signed, submittable op: sponsored by our engine, then signed by the account. */
  async function buildSignedOp(nonce: bigint): Promise<PackedUserOperation> {
    const chainId = await anvil.publicClient.getChainId();
    const withNonce = {...baseOp(), nonce};

    const attestation = await engine.attest({
      userOp: withNonce,
      chainId,
      paymaster,
      paymasterVerificationGasLimit: PM_VERIFICATION_GAS,
      postOpGasLimit: POSTOP_GAS,
      validUntil: 0,
      validAfter: 0,
    });

    const sponsored = {...withNonce, paymasterAndData: attestation.paymasterAndData};

    const userOpHash = (await anvil.publicClient.readContract({
      address: entryPoint,
      abi: entryPointAbi,
      functionName: "getUserOpHash",
      args: [sponsored],
    })) as Hex;

    return {...sponsored, signature: await accountOwner.signMessage({message: {raw: userOpHash}})};
  }

  async function currentNonce(): Promise<bigint> {
    return (await anvil.publicClient.readContract({
      address: entryPoint,
      abi: entryPointAbi,
      functionName: "getNonce",
      args: [account, 0n],
    })) as bigint;
  }

  async function setDeposit(target: bigint): Promise<void> {
    const current = (await anvil.publicClient.readContract({
      address: entryPoint,
      abi: entryPointAbi,
      functionName: "balanceOf",
      args: [paymaster],
    })) as bigint;

    if (current > target) {
      await anvil.publicClient.waitForTransactionReceipt({
        hash: await anvil.walletClient.writeContract({
          address: paymaster,
          abi: loadArtifact("VerifyingPaymaster.sol", "VerifyingPaymaster").abi,
          functionName: "withdrawTo",
          args: [anvil.deployer, current - target],
          account: anvil.walletClient.account!,
          chain: anvil.walletClient.chain!,
        }),
      });
    } else if (current < target) {
      await anvil.publicClient.waitForTransactionReceipt({
        hash: await anvil.walletClient.writeContract({
          address: entryPoint,
          abi: entryPointAbi,
          functionName: "depositTo",
          args: [paymaster],
          value: target - current,
          account: anvil.walletClient.account!,
          chain: anvil.walletClient.chain!,
        }),
      });
    }
  }

  async function handleOps(op: PackedUserOperation): Promise<Hex> {
    return anvil.walletClient.writeContract({
      address: entryPoint,
      abi: entryPointAbi,
      functionName: "handleOps",
      args: [[op], anvil.deployer],
      account: anvil.walletClient.account!,
      chain: anvil.walletClient.chain!,
    });
  }

  it("computes the same total the EntryPoint requires", () => {
    const expected =
      (VERIFICATION_GAS + CALL_GAS + PM_VERIFICATION_GAS + POSTOP_GAS + PRE_VERIFICATION_GAS) * MAX_FEE;

    expect(
      calculateMaxCost({
        userOp: baseOp(),
        paymasterVerificationGasLimit: PM_VERIFICATION_GAS,
        postOpGasLimit: POSTOP_GAS,
      }),
    ).toBe(expected);
  });

  it("uses maxFeePerGas, not maxPriorityFeePerGas", () => {
    // Guards against inverting the gasFees halves: maxPriorityFeePerGas is the HIGH half.
    const cost = calculateMaxCost({
      userOp: baseOp(),
      paymasterVerificationGasLimit: PM_VERIFICATION_GAS,
      postOpGasLimit: POSTOP_GAS,
    });
    const totalGas = VERIFICATION_GAS + CALL_GAS + PM_VERIFICATION_GAS + POSTOP_GAS + PRE_VERIFICATION_GAS;

    expect(cost).toBe(totalGas * MAX_FEE);
    expect(cost).not.toBe(totalGas * MAX_PRIORITY_FEE);
  });

  /** A deposit of exactly maxCost must be enough. If our formula over-estimates, this fails. */
  it("a deposit of exactly maxCost is sufficient", async () => {
    const op = await buildSignedOp(await currentNonce());
    const maxCost = calculateMaxCost({
      userOp: op,
      paymasterVerificationGasLimit: PM_VERIFICATION_GAS,
      postOpGasLimit: POSTOP_GAS,
    });

    await setDeposit(maxCost);
    const receipt = await anvil.publicClient.waitForTransactionReceipt({hash: await handleOps(op)});

    expect(receipt.status).toBe("success");
  });

  /** One wei less must be refused. If our formula under-estimates, this fails. */
  it("a deposit of maxCost - 1 is refused with AA31", async () => {
    const op = await buildSignedOp(await currentNonce());
    const maxCost = calculateMaxCost({
      userOp: op,
      paymasterVerificationGasLimit: PM_VERIFICATION_GAS,
      postOpGasLimit: POSTOP_GAS,
    });

    await setDeposit(maxCost - 1n);

    await expect(handleOps(op)).rejects.toThrow(/AA31|paymaster deposit too low/i);
  });

  /** The end-to-end claim: our signature really does get an operation sponsored. */
  it("sponsors the operation without the account paying", async () => {
    const op = await buildSignedOp(await currentNonce());
    const maxCost = calculateMaxCost({
      userOp: op,
      paymasterVerificationGasLimit: PM_VERIFICATION_GAS,
      postOpGasLimit: POSTOP_GAS,
    });
    await setDeposit(maxCost * 2n);

    const depositBefore = (await anvil.publicClient.readContract({
      address: entryPoint,
      abi: entryPointAbi,
      functionName: "balanceOf",
      args: [paymaster],
    })) as bigint;
    const accountBalanceBefore = await anvil.publicClient.getBalance({address: account});

    const receipt = await anvil.publicClient.waitForTransactionReceipt({hash: await handleOps(op)});
    expect(receipt.status).toBe("success");

    const depositAfter = (await anvil.publicClient.readContract({
      address: entryPoint,
      abi: entryPointAbi,
      functionName: "balanceOf",
      args: [paymaster],
    })) as bigint;

    expect(depositAfter, "paymaster deposit must have paid for the op").toBeLessThan(depositBefore);
    expect(await anvil.publicClient.getBalance({address: account})).toBe(accountBalanceBefore);
    expect(accountBalanceBefore).toBe(0n);
  });

  /** The actual charge is below the worst case, which is why spend caps run conservative. */
  it("actual cost is less than maxCost", async () => {
    const op = await buildSignedOp(await currentNonce());
    const maxCost = calculateMaxCost({
      userOp: op,
      paymasterVerificationGasLimit: PM_VERIFICATION_GAS,
      postOpGasLimit: POSTOP_GAS,
    });
    await setDeposit(maxCost * 2n);

    const before = (await anvil.publicClient.readContract({
      address: entryPoint,
      abi: entryPointAbi,
      functionName: "balanceOf",
      args: [paymaster],
    })) as bigint;

    await anvil.publicClient.waitForTransactionReceipt({hash: await handleOps(op)});

    const after = (await anvil.publicClient.readContract({
      address: entryPoint,
      abi: entryPointAbi,
      functionName: "balanceOf",
      args: [paymaster],
    })) as bigint;

    const actual = before - after;
    expect(actual).toBeGreaterThan(0n);
    expect(actual, "worst-case maxCost must bound the real charge").toBeLessThan(maxCost);
  });
});
