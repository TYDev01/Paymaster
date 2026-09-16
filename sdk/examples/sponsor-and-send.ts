/**
 * End-to-end example: sponsor a UserOperation and send it, with the account paying no gas.
 *
 * This is the flow td.md and td2.md describe — the SDK drives both the paymaster and the bundler.
 * It is deliberately runnable against the real stack rather than pseudocode:
 *
 *   1. ./start.sh                    (postgres, redis, bundler, backend — all against Sepolia)
 *   2. deploy a staked paymaster to Sepolia, if you have not:
 *        forge script script/DeployPaymaster.s.sol --rpc-url $RPC_URL --broadcast
 *      start.sh generates CHAINS from the broadcast receipt, so nothing is transcribed.
 *   3. mint an API key:  npm run key:generate  (in backend/)
 *   4. SMART_ACCOUNT=0x... ACCOUNT_OWNER_KEY=0x... API_KEY=... tsx sdk/examples/sponsor-and-send.ts
 *
 * THE SMART ACCOUNT IS YOURS TO PROVIDE. On the old anvil devnet a SimpleAccount was deployed for
 * you by local-setup.sh; on Sepolia there is no such thing, so deploy one (any ERC-4337 v0.7
 * account) and pass its address. It does NOT need to be funded — that is the entire point of the
 * paymaster — but it MUST already be deployed, or validation fails with AA20 rather than
 * anything that mentions the account.
 *
 * The account owner key here signs the UserOperation. It never leaves this process, and the SDK
 * never sees it — the SDK is handed a signing callback, not a key.
 */
import {createPublicClient, encodeFunctionData, http, parseAbi, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";

import {SponsoredBundlerClient} from "../src/index.js";

async function main(): Promise<void> {
  const config = {
    chainId: Number(process.env["CHAIN_ID"] ?? 11155111),
    entryPoint: (process.env["ENTRY_POINT"] ?? "0x0000000071727De22E5E9d8BAf0edAc6f37da032") as Address,
    paymasterEndpoint: process.env["PAYMASTER_URL"] ?? "http://localhost:3100",
    bundlerEndpoint: process.env["BUNDLER_URL"] ?? "http://localhost:3001",
    apiKey: required("API_KEY"),
    accountOwnerKey: required("ACCOUNT_OWNER_KEY") as Hex,
    smartAccount: required("SMART_ACCOUNT") as Address,
    rpcUrl: process.env["RPC_URL"] ?? "https://ethereum-sepolia-rpc.publicnode.com",
  };

  const owner = privateKeyToAccount(config.accountOwnerKey);
  const chain = createPublicClient({transport: http(config.rpcUrl)});

  const client = new SponsoredBundlerClient({
    entryPoint: config.entryPoint,
    chainId: config.chainId,
    bundler: {endpoint: config.bundlerEndpoint},
    paymaster: {endpoint: config.paymasterEndpoint, apiKey: config.apiKey},
  });

  // Read the account's next nonce and current fees from the chain.
  const nonce = (await chain.readContract({
    address: config.entryPoint,
    abi: parseAbi(["function getNonce(address,uint192) view returns (uint256)"]),
    functionName: "getNonce",
    args: [config.smartAccount, 0n],
  })) as bigint;
  const block = await chain.getBlock();
  const maxFeePerGas = (block.baseFeePerGas ?? 1_000_000_000n) * 2n + 1_000_000_000n;

  // The operation: a no-op call to the burn address, to demonstrate the mechanics.
  const callData = encodeFunctionData({
    abi: parseAbi(["function execute(address dest, uint256 value, bytes func)"]),
    functionName: "execute",
    args: ["0x000000000000000000000000000000000000dEaD", 0n, "0x"],
  });

  console.log("sponsoring and sending...");
  const receipt = await client.sendUserOperation(
    {sender: config.smartAccount, nonce, callData},
    {
      maxFeePerGas,
      maxPriorityFeePerGas: 1_000_000_000n,
      // SimpleAccount verifies an EIP-191 personal-signed hash. A different account signs its own way.
      signUserOperationHash: (hash) => owner.signMessage({message: {raw: hash}}),
    },
  );

  console.log(`mined in ${receipt.transactionHash}`);
  console.log(`success: ${receipt.success}`);
  console.log(`gas paid by the paymaster: ${receipt.actualGasCost} wei`);

  const balance = await chain.getBalance({address: config.smartAccount});
  console.log(`account balance (unchanged, it paid nothing): ${balance} wei`);
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`set ${name} in the environment (see the header of this file)`);
  }
  return value;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
