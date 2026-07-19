/**
 * End-to-end example: sponsor a UserOperation and send it, with the account paying no gas.
 *
 * This is the flow td.md and td2.md describe — the SDK drives both the paymaster and the bundler.
 * It is deliberately runnable against the local docker-compose stack rather than pseudocode:
 *
 *   1. docker compose up -d          (postgres, redis, anvil, bundler, backend)
 *   2. deploy an EntryPoint + a staked VerifyingPaymaster + a SimpleAccount to the anvil chain,
 *      and configure CHAINS to point at them   (see deploy/ — a helper script lands there next)
 *   3. mint an API key:  npm run key:generate  (in backend/)
 *   4. tsx sdk/examples/sponsor-and-send.ts
 *
 * The account owner key here signs the UserOperation. It never leaves this process, and the SDK
 * never sees it — the SDK is handed a signing callback, not a key.
 */
import {createPublicClient, encodeFunctionData, http, parseAbi, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";

import {SponsoredBundlerClient} from "../src/index.js";

async function main(): Promise<void> {
  const config = {
    chainId: Number(process.env["CHAIN_ID"] ?? 31337),
    entryPoint: (process.env["ENTRY_POINT"] ?? "0x0000000071727De22E5E9d8BAf0edAc6f37da032") as Address,
    paymasterEndpoint: process.env["PAYMASTER_URL"] ?? "http://localhost:3000",
    bundlerEndpoint: process.env["BUNDLER_URL"] ?? "http://localhost:3001",
    apiKey: required("API_KEY"),
    accountOwnerKey: required("ACCOUNT_OWNER_KEY") as Hex,
    smartAccount: required("SMART_ACCOUNT") as Address,
    rpcUrl: process.env["RPC_URL"] ?? "http://localhost:8545",
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
