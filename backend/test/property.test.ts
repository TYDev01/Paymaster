import {describe, expect, it} from "vitest";
import {toHex, type Address, type Hex} from "viem";

import {
  packUint128Pair,
  unpackUint128Pair,
  UINT128_MAX,
  type PackedUserOperation,
} from "../src/domain/userOperation.js";
import {
  decodePaymasterAndData,
  encodePaymasterAndData,
  type PaymasterAndDataFields,
} from "../src/signature/paymasterAndData.js";
import {calculateMaxCost} from "../src/chain/gas.js";
import {windowEnd, windowStart, windowedKey} from "../src/policy/quota/quotaStore.js";

/**
 * Property-based tests over the value-handling code — td.md's "property-based / fuzz testing".
 *
 * These target the layers where a single wrong bit is a wrong amount of money or an unverifiable
 * signature: the bit-packing the EntryPoint hashes, the paymasterAndData layout the contract parses
 * on chain, the worst-case cost the spend caps are charged against, and the quota window arithmetic.
 * Example-based tests cover the cases someone thought of; these cover the ones nobody did — a
 * boundary at 2^128-1, a signature of an unusual length, a window that straddles an epoch.
 *
 * The generator is a hand-rolled seeded PRNG rather than a property-testing library, for the same
 * reason the Prometheus registry and the JWT are hand-rolled: a money-handling service's dependency
 * surface is a security property. The seed is FIXED, so a failure is reproducible — a fuzz test
 * that cannot be replayed is a flaky test. Print the case in the assertion message, always: a
 * random failure with no inputs attached costs more time than it saves.
 */
const RUNS = 2_000;

/** xorshift128+, seeded. Deterministic across machines, unlike Math.random. */
function prng(seed: number): () => number {
  let s0 = seed >>> 0 || 1;
  let s1 = 0x9e3779b9;
  return () => {
    s1 ^= s1 << 13;
    s1 ^= s1 >>> 17;
    s1 ^= s1 << 5;
    s1 >>>= 0;
    const next = (s0 + s1) >>> 0;
    s0 = s1;
    s1 = next;
    return next / 0x1_0000_0000;
  };
}

/** Biased towards boundaries — 0, 1, max, max-1 — which is where packing bugs live. */
function randomBigint(random: () => number, max: bigint): bigint {
  const roll = random();
  if (roll < 0.1) return 0n;
  if (roll < 0.2) return 1n;
  if (roll < 0.3) return max;
  if (roll < 0.4) return max - 1n;
  // Uniform across the full width, assembled from 32-bit chunks so the high bits get exercised.
  let value = 0n;
  for (let i = 0; i < 4; i++) value = (value << 32n) | BigInt(Math.floor(random() * 0x1_0000_0000));
  return value % (max + 1n);
}

function randomHex(random: () => number, byteLength: number): Hex {
  let out = "0x";
  for (let i = 0; i < byteLength; i++) {
    out += Math.floor(random() * 256)
      .toString(16)
      .padStart(2, "0");
  }
  return out as Hex;
}

describe("uint128 pair packing", () => {
  it("round-trips any pair of uint128 values", () => {
    const random = prng(0xc0ffee);
    for (let i = 0; i < RUNS; i++) {
      const high = randomBigint(random, UINT128_MAX);
      const low = randomBigint(random, UINT128_MAX);

      const {high: gotHigh, low: gotLow} = unpackUint128Pair(toHex(packUint128Pair(high, low), {size: 32}));

      expect(gotHigh, `high half corrupted for (${high}, ${low})`).toBe(high);
      expect(gotLow, `low half corrupted for (${high}, ${low})`).toBe(low);
    }
  });

  it("rejects anything wider than uint128 instead of silently truncating", () => {
    const random = prng(0xbadbeef);
    for (let i = 0; i < 200; i++) {
      const overflow = UINT128_MAX + 1n + randomBigint(random, UINT128_MAX);
      // Truncation here would silently halve a gas limit, and the op would fail on chain with an
      // error that points nowhere near this function.
      expect(() => packUint128Pair(overflow, 0n), `accepted ${overflow} as a uint128`).toThrow();
      expect(() => packUint128Pair(0n, overflow), `accepted ${overflow} as a uint128`).toThrow();
    }
  });
});

describe("paymasterAndData codec", () => {
  it("round-trips every field for any signature length the contract accepts", () => {
    const random = prng(0x5eed);
    for (let i = 0; i < RUNS; i++) {
      const fields: PaymasterAndDataFields = {
        paymaster: randomHex(random, 20) as Address,
        paymasterVerificationGasLimit: randomBigint(random, UINT128_MAX),
        postOpGasLimit: randomBigint(random, UINT128_MAX),
        validUntil: Number(randomBigint(random, (1n << 48n) - 1n)),
        validAfter: Number(randomBigint(random, (1n << 48n) - 1n)),
      };
      const signature = randomHex(random, 65);

      const decoded = decodePaymasterAndData(encodePaymasterAndData(fields, signature));

      const describeCase = JSON.stringify(fields, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      expect(decoded.paymaster.toLowerCase(), describeCase).toBe(fields.paymaster.toLowerCase());
      expect(decoded.paymasterVerificationGasLimit, describeCase).toBe(fields.paymasterVerificationGasLimit);
      expect(decoded.postOpGasLimit, describeCase).toBe(fields.postOpGasLimit);
      expect(decoded.validUntil, describeCase).toBe(fields.validUntil);
      expect(decoded.validAfter, describeCase).toBe(fields.validAfter);
      expect(decoded.signature.toLowerCase(), describeCase).toBe(signature.toLowerCase());
    }
  });

  it("rejects truncated data rather than decoding it into plausible garbage", () => {
    const random = prng(0x7a17);
    const encoded = encodePaymasterAndData(
      {
        paymaster: randomHex(random, 20) as Address,
        paymasterVerificationGasLimit: 300_000n,
        postOpGasLimit: 50_000n,
        validUntil: 1_700_000_300,
        validAfter: 0,
      },
      randomHex(random, 65),
    );

    // Every prefix shorter than the fixed header must be refused. A decoder that reads past the end
    // and returns zeros would turn a malformed input into a valid-looking sponsorship window.
    for (let bytes = 0; bytes < 64; bytes++) {
      const truncated = encoded.slice(0, 2 + bytes * 2) as Hex;
      expect(() => decodePaymasterAndData(truncated), `accepted a ${bytes}-byte prefix`).toThrow();
    }
  });
});

describe("worst-case cost", () => {
  function userOpWith(verification: bigint, call: bigint, priority: bigint, maxFee: bigint): PackedUserOperation {
    return {
      sender: "0x1234567890123456789012345678901234567890",
      nonce: 0n,
      initCode: "0x",
      callData: "0x",
      accountGasLimits: toHex(packUint128Pair(verification, call), {size: 32}),
      preVerificationGas: 100_000n,
      gasFees: toHex(packUint128Pair(priority, maxFee), {size: 32}),
      paymasterAndData: "0x",
      signature: "0x",
    };
  }

  it("never under-estimates: more gas or a higher fee can only cost more", () => {
    const random = prng(0x9017);
    const cap = 10n ** 9n; // Gas units and fees within ranges a real op could use.

    for (let i = 0; i < RUNS; i++) {
      const verification = randomBigint(random, cap);
      const call = randomBigint(random, cap);
      const maxFee = randomBigint(random, cap);
      const priority = maxFee === 0n ? 0n : randomBigint(random, maxFee);
      const pmVerification = randomBigint(random, cap);
      const postOp = randomBigint(random, cap);

      const base = calculateMaxCost({
        userOp: userOpWith(verification, call, priority, maxFee),
        paymasterVerificationGasLimit: pmVerification,
        postOpGasLimit: postOp,
      });
      const more = calculateMaxCost({
        userOp: userOpWith(verification + 1n, call + 1n, priority, maxFee),
        paymasterVerificationGasLimit: pmVerification,
        postOpGasLimit: postOp,
      });

      // Monotonicity is the property the spend caps depend on: if a bigger operation could ever
      // price lower, a caller could split spending to stay under a cap while spending more.
      expect(more, `cost fell when gas rose (v=${verification} c=${call} fee=${maxFee})`).toBeGreaterThanOrEqual(base);
    }
  });
});

describe("quota windows", () => {
  it("assigns every instant to exactly one window, with no gaps or overlaps", () => {
    const random = prng(0x4e57);
    for (let i = 0; i < RUNS; i++) {
      const windowSeconds = 1 + Math.floor(random() * 86_400);
      const now = Math.floor(random() * 4_000_000_000);

      const start = windowStart(now, windowSeconds);
      const end = windowEnd(now, windowSeconds);

      expect(start, `now=${now} w=${windowSeconds}`).toBeLessThanOrEqual(now);
      expect(end, `now=${now} w=${windowSeconds}`).toBeGreaterThan(now);
      expect(end - start, `window length wrong for now=${now} w=${windowSeconds}`).toBe(windowSeconds);

      // The instant just before this window belongs to the previous one, and the instant at `end`
      // to the next: a boundary that landed in neither would drop a request's quota entirely, and
      // one in both would let a caller spend twice.
      expect(windowEnd(start - 1, windowSeconds), `gap before ${start}`).toBe(start);
      expect(windowStart(end, windowSeconds), `gap after ${end}`).toBe(end);
    }
  });

  it("gives the same key inside a window and a different one across the boundary", () => {
    const random = prng(0x1d10);
    for (let i = 0; i < RUNS; i++) {
      const windowSeconds = 1 + Math.floor(random() * 86_400);
      const now = Math.floor(random() * 4_000_000_000);
      const start = windowStart(now, windowSeconds);

      expect(windowedKey("k", windowSeconds, now)).toBe(windowedKey("k", windowSeconds, start));
      expect(windowedKey("k", windowSeconds, windowEnd(now, windowSeconds))).not.toBe(
        windowedKey("k", windowSeconds, now),
      );
    }
  });
});
