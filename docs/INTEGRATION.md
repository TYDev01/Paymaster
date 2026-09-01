# Integration guide

For a **customer**: you have an account on a paymaster someone else runs, and you want your users'
transactions to cost them nothing. If you are running the platform yourself, see
[OPERATIONS.md](OPERATIONS.md) instead.

The whole thing is five steps and one rule.

**The rule: your API key belongs on a server you control.** It is a bearer secret with no origin
or domain binding — a key shipped to a browser can be read out of the page by anyone who loads it
and used to spend your balance until it is empty. Nothing downstream can protect you from that, so
the shape below puts the key behind your own backend, where your own auth decides who deserves
sponsorship.

```
your users ──▶ your app ──▶ your backend ──▶ paymaster API   (decides + signs)
                                        └──▶ bundler         (submits on chain)
```

---

## 1. Sign up

Sign in at `/dashboard`. On first sign-in you get a tenant of your own, which is the boundary
everything else hangs off: your balance, your keys, your policy, your usage. Nothing is shared with
another tenant, and that isolation is enforced in the query layer rather than by convention.

Your tenant automatically gets a starter policy — the rules that decide what you are allowed to
sponsor. Typical starting limits are 100 operations and 0.1 ETH per wallet per day; check
`/dashboard` for yours, and ask the operator to change them if they do not fit.

## 2. Fund your balance

**On a multi-tenant deployment your gas comes from a balance you own on chain.** Not an invoice, not
a prepaid credit in someone's database — a deposit held by the paymaster contract and attributed to
you. Only your operations spend it, and the contract enforces that rather than the operator's
bookkeeping.

Go to `/dashboard/funding`, enter an amount, press **Deposit**. Your wallet signs a call to the
paymaster and the balance updates once it is mined.

Two things worth understanding, because they are unusual:

**A deposit is credited to your TENANT KEY, not your wallet address.** The tenant key is the
`bytes32` shown on that page. The contract has no way to work out which tenant a plain transfer
belongs to — the id is hashed one-way, so a sender address maps to nothing — which is why funding
is a call to `depositFor(bytes32)` rather than a transfer.

**Sending ETH straight to the paymaster address will fail, not vanish.** `TenantPaymaster` has no
plain-transfer path, so such a transaction reverts and you keep your money. Use the Deposit button,
or call `depositFor` yourself:

```bash
cast send <paymaster> "depositFor(bytes32)" <your-tenant-key> \
  --value 0.05ether --rpc-url <rpc> --private-key <key>
```

If the deployment uses a *verifying* paymaster rather than a tenant one, there is no balance of
yours to fund: the operator sponsors from a single shared deposit and your usage is bounded by
policy alone. The funding page says so when that is the case.

## 3. Mint an API key

`/dashboard/keys` → **Sponsor** role → mint. The secret is shown once and stored only as a hash; if
you lose it, mint a replacement and revoke the old one.

`Sponsor` can spend your balance within policy and do nothing else. It cannot mint keys, change
policy, or read your account — so a leaked key is bounded by your quotas, which is the strongest
reason to keep those quotas tight.

Put the secret in your server's environment. Not in a `.env` that ships to the browser, not in a
build artifact, not in a mobile app binary.

## 4. Call it from your server

```bash
npm install @paymaster/sdk viem
```

```ts
import {SponsoredBundlerClient} from "@paymaster/sdk";

const client = new SponsoredBundlerClient({
  entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  chainId: 11155111,
  bundler: {endpoint: process.env.BUNDLER_URL!},
  paymaster: {endpoint: process.env.PAYMASTER_URL!, apiKey: process.env.PAYMASTER_API_KEY!},
});

const receipt = await client.sendUserOperation(
  {
    sender: smartAccountAddress,
    nonce: await readNonceFromEntryPoint(smartAccountAddress),
    callData: encodedCall,
    // Read fees from the chain. A fee below its floor is rejected by the bundler, and the
    // SDK's defaults are a fallback rather than a substitute for asking.
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  },
  {signUserOperationHash: async (hash) => owner.signMessage({message: {raw: hash}})},
);
```

`sendUserOperation` does the whole round trip: estimates gas, asks the paymaster to sponsor, has you
sign the resulting hash, submits to the bundler and waits for the receipt.

**The SDK never sees a private key.** You hand it a `signUserOperationHash` callback, not a key —
so the signing stays wherever you keep it, including an HSM or a remote signer.

If you want the two halves separately — to inspect the sponsorship before committing, or to sign
somewhere else entirely — use `prepareUserOperation`, or the `PaymasterClient` and `BundlerClient`
directly.

### The smart account is yours to provide

Sponsorship pays gas for an account; it does not create one. The account must **already be
deployed** on chain, or validation fails with `AA20` — an error that names the account and not the
missing deployment. Any ERC-4337 v0.7 account works. It does not need to hold a balance; that is
the entire point.

A runnable end-to-end example is in
[`sdk/examples/sponsor-and-send.ts`](../sdk/examples/sponsor-and-send.ts). It expects you to pass
`SMART_ACCOUNT` — it does not deploy one for you either.

To get an account for testing, deploy any v0.7 factory and call it once:

```bash
forge create lib/account-abstraction/contracts/samples/SimpleAccountFactory.sol:SimpleAccountFactory \
  --constructor-args 0x0000000071727De22E5E9d8BAf0edAc6f37da032 --broadcast \
  --rpc-url "$RPC_URL" --private-key "$KEY"

cast send <factory> "createAccount(address,uint256)" <owner-address> 0 \
  --rpc-url "$RPC_URL" --private-key "$KEY"
```

The owner is whichever key signs the operation hash. It needs no balance.

## 5. Watch your balance

A deposit that reaches zero fails **every** operation with `AA31`, and nothing else warns you first
if you are not looking. The dashboard shows the balance; the operator's `FundingMonitor` alerts
below a threshold, but that alert goes to *them*, not to you.

---

## When it goes wrong

**Read `code`, not `error`.** Every policy refusal comes back as the same top-level
`error: "SPONSORSHIP_DENIED"`; the reason is the `code` beside it. Branching on `error` collapses
"you are out of money" and "that account is blocklisted" into one case.

```json
{"error": "SPONSORSHIP_DENIED", "code": "TENANT_BALANCE_INSUFFICIENT"}
```

The status tells you what KIND of response is appropriate, and the three are meaningfully different:
**402** means add funds, **429** means back off and retry, **403** means this request will never be
allowed as written.

| Status | `code` | What it means |
| --- | --- | --- |
| 402 | `TENANT_BALANCE_INSUFFICIENT` | Your own balance is empty. Deposit more |
| 402 | `SUBSCRIPTION_LAPSED` | The platform subscription is unpaid — separate from your gas balance, which is untouched |
| 429 | `QUOTA_EXCEEDED` | A quota is exhausted. Retry after it resets |
| 429 | `SPEND_CAP_EXCEEDED` | A policy spend cap, not your balance — fixed by changing the rule, not by funding |
| 403 | `CHAIN_DISABLED` | That `chainId` is not enabled for you |
| 403 | `SENDER_NOT_ALLOWED` / `SENDER_BLOCKED` | The account is outside an allowlist, or on a blocklist |
| 403 | `TARGET_NOT_ALLOWED` / `METHOD_NOT_ALLOWED` / `VALUE_NOT_ALLOWED` | The call itself is outside policy — what it touches, which function, or how much value |
| 403 | `CALLDATA_UNDECODABLE` | A rule needed to inspect the call and could not parse it |
| 403 | `TOKEN_BALANCE_INSUFFICIENT` | A rule requires the sender to hold a token, and it does not |
| 403 | `RULE_ERROR` | A rule failed to evaluate. The operator's problem, not yours |

Other statuses come from outside the policy engine: **400** `INVALID_REQUEST` for a malformed user
operation (the message names the field), **401** for an API key that is wrong, revoked, or missing
its `Authorization: Bearer` header, and **503** when a chain's RPC is unreachable.

`SPEND_CAP_EXCEEDED` and `TENANT_BALANCE_INSUFFICIENT` are the pair worth keeping straight: the
first is a limit the operator chose and only they can raise; the second is your own money running
out, which you fix by depositing.

Three failures that are **not** the paymaster's, and look like it:

**`AA20 account not deployed`** — your smart account does not exist on chain yet. Deploy it.

**`AA31 paymaster deposit too low`** — the operator's overall deposit is exhausted, not yours. Tell
them.

**`AA34 signature error`** — the attestation did not verify on chain. Almost always a configuration
mismatch on the operator's side (a `paymasterKind` that disagrees with the deployed contract, or a
signer key that is not the address the contract stores), not anything you did.

### A quota trap while developing

A sponsorship reserves `maxCost` against your quota **when it is signed**, and that reservation is
only corrected from a receipt once the operation actually lands. So operations you sign and never
submit — because your bundler is misconfigured, or your account is not deployed, or you were just
iterating — hold their reservation permanently.

The practical consequence: a wallet can exhaust its daily spend quota during debugging without a
single successful sponsorship, and then return 429 for the rest of the day. If you hit a quota wall
having landed nothing, this is why. Ask the operator to clear the counter, or test with a different
sender.

## Going to production

- **Rotate the key** you developed with, and revoke it. Anything pasted into a terminal, a CI log or
  a chat message should be considered burned.
- **Mint one key per service**, named after the thing that holds it, so revoking one does not take
  down everything else.
- **Set quotas you would be comfortable losing.** They are what bounds a leaked key.
- **Monitor the balance**, and alert on it yourself rather than relying on the operator's alert.
- **Confirm the chain**. A `chainId` that is not enabled fails fast, which is the good case; a
  paymaster address pointing at the wrong deployment fails as `AA34`, which is not.
