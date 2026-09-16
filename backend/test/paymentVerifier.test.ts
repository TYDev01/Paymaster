import {describe, expect, it} from "vitest";
import type {Address, Hex} from "viem";

import {PaymentVerificationError, PaymentVerifier} from "../src/billing/paymentVerifier.js";
import {parsePlansJson} from "../src/billing/plans.js";
import type {NativeTransfer} from "../src/chain/chainAdapter.js";
import type {ChainRegistry} from "../src/chain/chainRegistry.js";
import {tenantId} from "../src/db/scope.js";
import {onChainTenantKey} from "../src/signature/paymasterLayout.js";

const TREASURY = "0x1111111111111111111111111111111111111111" as Address;
const ACME = tenantId("t_acme");
const RIVAL = tenantId("t_rival");
const HASH = `0x${"ab".repeat(32)}` as Hex;
const PRICE = 10_000_000_000_000_000n;

const plan = parsePlansJson(
  JSON.stringify([{id: "growth", name: "Growth", periodSeconds: 2_592_000, priceWei: {"11155111": PRICE.toString()}}]),
).get("growth");

/** A chain that knows exactly one transaction, at a chosen depth below the head. */
function chainWith(transfer: Partial<NativeTransfer> | undefined, head = 1_000n): ChainRegistry {
  const full: NativeTransfer | undefined =
    transfer === undefined
      ? undefined
      : {
          hash: HASH,
          from: "0x2222222222222222222222222222222222222222",
          to: TREASURY,
          valueWei: PRICE,
          input: onChainTenantKey(ACME),
          success: true,
          blockNumber: 990n,
          ...transfer,
        };
  return {
    getEvenIfDisabled: () => ({
      getNativeTransfer: async (hash: Hex) => (hash === HASH ? full : undefined),
      blockNumber: async () => head,
    }),
  } as unknown as ChainRegistry;
}

function verifier(chains: ChainRegistry) {
  return new PaymentVerifier(chains, {treasury: TREASURY, confirmations: 5, maxPeriodsPerPayment: 12});
}

async function rejection(chains: ChainRegistry, tenant = ACME, chainId = 11155111): Promise<string> {
  try {
    await verifier(chains).verify({chainId, txHash: HASH, tenant, plan});
  } catch (error) {
    if (error instanceof PaymentVerificationError) return error.code;
    throw error;
  }
  throw new Error("expected the payment to be refused");
}

describe("payment verification", () => {
  it("accepts a confirmed transfer of the price to the treasury that names this account", async () => {
    const verified = await verifier(chainWith({})).verify({chainId: 11155111, txHash: HASH, tenant: ACME, plan});
    expect(verified).toMatchObject({chainId: 11155111, amountWei: PRICE, periods: 1});
  });

  it("refuses a payment that names ANOTHER account, so nobody can claim someone else's transfer", async () => {
    expect(await rejection(chainWith({}), RIVAL)).toBe("WRONG_ACCOUNT");
  });

  it("refuses a transfer with no reference at all", async () => {
    expect(await rejection(chainWith({input: "0x"}))).toBe("WRONG_ACCOUNT");
  });

  it("refuses a payment to any address but the treasury", async () => {
    expect(await rejection(chainWith({to: "0x3333333333333333333333333333333333333333"}))).toBe("WRONG_RECIPIENT");
    expect(await rejection(chainWith({to: null}))).toBe("WRONG_RECIPIENT");
  });

  it("refuses less than the price", async () => {
    expect(await rejection(chainWith({valueWei: PRICE - 1n}))).toBe("UNDERPAID");
  });

  it("refuses a reverted transaction", async () => {
    expect(await rejection(chainWith({success: false}))).toBe("REVERTED");
  });

  it("refuses an unknown transaction and says to wait", async () => {
    expect(await rejection(chainWith(undefined))).toBe("NOT_FOUND");
  });

  it("refuses a payment until it has enough confirmations", async () => {
    // Mined at 998 with the head at 1000: three blocks deep, five required.
    expect(await rejection(chainWith({blockNumber: 998n}))).toBe("UNCONFIRMED");
    await expect(
      verifier(chainWith({blockNumber: 996n})).verify({chainId: 11155111, txHash: HASH, tenant: ACME, plan}),
    ).resolves.toBeDefined();
  });

  it("refuses payment on a chain the plan is not sold on", async () => {
    expect(await rejection(chainWith({}), ACME, 1)).toBe("NOT_SOLD_ON_CHAIN");
  });

  it("buys whole extra periods for an overpayment, up to the cap", async () => {
    const three = await verifier(chainWith({valueWei: PRICE * 3n + 5n})).verify({
      chainId: 11155111,
      txHash: HASH,
      tenant: ACME,
      plan,
    });
    expect(three.periods).toBe(3);

    const capped = await verifier(chainWith({valueWei: PRICE * 100n})).verify({
      chainId: 11155111,
      txHash: HASH,
      tenant: ACME,
      plan,
    });
    expect(capped.periods).toBe(12);
  });
});
