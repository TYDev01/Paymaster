# @paymaster/sdk

Framework-agnostic TypeScript SDK for the self-hosted Paymaster + Bundler platform. It drives both
services: sponsor a UserOperation at the paymaster, send it through the bundler, all in one call.

Runs anywhere `fetch` exists — browser, Node ≥ 18, Deno, Bun, edge. The only dependency is `viem`,
for hashing and encoding.

## Install

```
npm install @paymaster/sdk viem
```

## The one-call flow

```ts
import {SponsoredBundlerClient} from "@paymaster/sdk";
import {privateKeyToAccount} from "viem/accounts";

const owner = privateKeyToAccount(ACCOUNT_OWNER_KEY);

const client = new SponsoredBundlerClient({
  entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  chainId: 8453,
  bundler: {endpoint: "https://bundler.example.com"},
  paymaster: {endpoint: "https://paymaster.example.com", apiKey: "pm_live_..."},
});

const receipt = await client.sendUserOperation(
  {sender: smartAccount, nonce, callData},
  {
    maxFeePerGas,
    maxPriorityFeePerGas,
    // The SDK never holds your key. It hands you the hash; you sign it however your account expects.
    signUserOperationHash: (hash) => owner.signMessage({message: {raw: hash}}),
  },
);
// receipt.success === true, and the smart account paid nothing.
```

See [examples/sponsor-and-send.ts](examples/sponsor-and-send.ts) for a complete runnable script.

## Why one call, and why this order

Sponsoring and sending are coupled by a subtlety the SDK exists to hide. The account's signature is
over a hash that **includes** the paymaster data, so the operation must be sponsored *before* it is
signed. And the sponsorship's signature covers the gas limits, so the operation must be *estimated*
before it is sponsored. `sendUserOperation` sequences this correctly:

```
estimate (with a preliminary sponsorship, so the account is not charged)
  → sponsor over the estimated limits
  → hash (now covering the paymaster data)
  → sign
  → submit
```

Getting the order wrong produces an operation the bundler rejects for reasons that are miserable to
debug. Doing it by hand is exactly what this client removes.

## Lower-level clients

`SponsoredBundlerClient` is built from two clients you can use directly:

- **`PaymasterClient`** — `sponsor(userOp)` against the sponsorship API. This is td.md's
  `PaymasterClient`.
- **`BundlerClient`** — the standard ERC-4337 JSON-RPC methods (`eth_sendUserOperation`,
  `eth_estimateUserOperationGas`, `eth_getUserOperationReceipt`, …) against any conforming bundler.

`getUserOperationHash(op, entryPoint, chainId)` computes the v0.7 hash locally — the same value the
EntryPoint returns, verified against deployed bytecode in the platform's integration tests.

## Errors

- `HttpApiError` — from the paymaster API, carrying `status` and `errorCode` (e.g. `SENDER_BLOCKED`).
- `JsonRpcError` — from the bundler, carrying the JSON-RPC `code` (e.g. `-32502` for a stake issue).

Both extend `PaymasterSdkError`, so `instanceof` lets a caller branch on where a failure came from.
