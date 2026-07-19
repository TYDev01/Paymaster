import {describe, expect, it, vi} from "vitest";
import type {Address, Hex} from "viem";

import {
  BundlerClient,
  encodeInitCode,
  encodePaymasterAndData,
  getUserOperationHash,
  HttpApiError,
  JsonRpcError,
  PaymasterClient,
  toRpcUserOperation,
  type UserOperation,
} from "../src/index.js";

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;
const SENDER = "0x1234567890123456789012345678901234567890" as Address;
const PAYMASTER = "0x1111111111111111111111111111111111111111" as Address;

function op(over: Partial<UserOperation> = {}): UserOperation {
  return {
    sender: SENDER,
    nonce: 0n,
    callData: "0xdeadbeef",
    callGasLimit: 200_000n,
    verificationGasLimit: 500_000n,
    preVerificationGas: 100_000n,
    maxFeePerGas: 20_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    signature: "0x",
    ...over,
  };
}

/** A fetch double that records the last request and returns a canned response. */
function stubFetch(response: {status?: number; body: unknown}) {
  const calls: {url: string; init: RequestInit}[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({url: String(url), init: init ?? {}});
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: {"content-type": "application/json"},
    });
  });
  return {fn: fn as unknown as typeof fetch, calls};
}

describe("userOpHash encoding", () => {
  it("encodes empty initCode and paymasterAndData as 0x", () => {
    expect(encodeInitCode(op())).toBe("0x");
    expect(encodePaymasterAndData(op())).toBe("0x");
  });

  it("concatenates factory and factoryData into initCode", () => {
    const withFactory = op({factory: PAYMASTER, factoryData: "0xabcd"});
    expect(encodeInitCode(withFactory)).toBe(`${PAYMASTER.toLowerCase()}abcd`);
  });

  it("lays out paymasterAndData as address ++ 16-byte ++ 16-byte ++ tail", () => {
    const sponsored = op({
      paymaster: PAYMASTER,
      paymasterVerificationGasLimit: 300_000n,
      paymasterPostOpGasLimit: 50_000n,
      paymasterData: "0xcafe",
    });
    const encoded = encodePaymasterAndData(sponsored);
    // 20 + 16 + 16 + 2 bytes = 54 bytes = 108 hex chars + "0x".
    expect(encoded.length).toBe(2 + 54 * 2);
    expect(encoded.slice(0, 42).toLowerCase()).toBe(PAYMASTER.toLowerCase());
    expect(encoded.endsWith("cafe")).toBe(true);
  });
});

describe("getUserOperationHash", () => {
  it("is deterministic", () => {
    expect(getUserOperationHash(op(), ENTRY_POINT, 8453)).toBe(getUserOperationHash(op(), ENTRY_POINT, 8453));
  });

  /** Cross-chain replay protection lives in the hash: the same op hashes differently per chain. */
  it("depends on the chain id", () => {
    expect(getUserOperationHash(op(), ENTRY_POINT, 8453)).not.toBe(getUserOperationHash(op(), ENTRY_POINT, 42_161));
  });

  it("depends on the entry point", () => {
    const other = "0x0000000000000000000000000000000000000099" as Address;
    expect(getUserOperationHash(op(), ENTRY_POINT, 1)).not.toBe(getUserOperationHash(op(), other, 1));
  });

  it("changes when any signed field changes", () => {
    const base = getUserOperationHash(op(), ENTRY_POINT, 1);
    const mutations: UserOperation[] = [
      op({nonce: 1n}),
      op({callData: "0xdeadbeef00"}),
      op({callGasLimit: 200_001n}),
      op({verificationGasLimit: 500_001n}),
      op({preVerificationGas: 100_001n}),
      op({maxFeePerGas: 20_000_000_001n}),
      op({maxPriorityFeePerGas: 1_000_000_001n}),
      op({paymaster: PAYMASTER, paymasterData: "0x00"}),
    ];
    for (const mutated of mutations) {
      expect(getUserOperationHash(mutated, ENTRY_POINT, 1)).not.toBe(base);
    }
  });

  /** The signature is NOT part of the hash — that would be circular. */
  it("does not depend on the signature", () => {
    expect(getUserOperationHash(op({signature: "0xaa"}), ENTRY_POINT, 1)).toBe(
      getUserOperationHash(op({signature: "0xbb"}), ENTRY_POINT, 1),
    );
  });

  it("rejects a gas value that would overflow its uint128 slot", () => {
    expect(() => getUserOperationHash(op({callGasLimit: 1n << 128n}), ENTRY_POINT, 1)).toThrow(RangeError);
  });
});

describe("toRpcUserOperation", () => {
  it("hex-encodes quantities and omits absent paymaster/factory fields", () => {
    const rpc = toRpcUserOperation(op());
    expect(rpc["nonce"]).toBe("0x0");
    expect(rpc["maxFeePerGas"]).toBe("0x4a817c800");
    expect(rpc["paymaster"]).toBeUndefined();
    expect(rpc["factory"]).toBeUndefined();
  });

  it("includes paymaster fields when present", () => {
    const rpc = toRpcUserOperation(
      op({paymaster: PAYMASTER, paymasterVerificationGasLimit: 300_000n, paymasterPostOpGasLimit: 50_000n, paymasterData: "0xcafe"}),
    );
    expect(rpc["paymaster"]).toBe(PAYMASTER);
    expect(rpc["paymasterData"]).toBe("0xcafe");
  });
});

describe("PaymasterClient", () => {
  const response = {
    paymaster: PAYMASTER,
    paymasterVerificationGasLimit: "0x493e0",
    paymasterPostOpGasLimit: "0xc350",
    paymasterData: "0xcafe",
    validUntil: 1_900_000_000,
    validAfter: 0,
    metadata: {maxCost: "23000000000000000"},
  };

  it("posts to /paymaster/sponsor with the chain id and bearer token", async () => {
    const {fn, calls} = stubFetch({body: response});
    const client = new PaymasterClient({endpoint: "https://pm.example.com/", chainId: 8453, apiKey: "pm_test_key", transport: {fetch: fn}});

    const sponsorship = await client.sponsor(op());

    expect(calls[0]!.url).toBe("https://pm.example.com/paymaster/sponsor");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer pm_test_key");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.chainId).toBe(8453);
    expect(body.userOperation.maxFeePerGas).toBe("0x4a817c800");

    expect(sponsorship.paymaster).toBe(PAYMASTER);
    expect(sponsorship.maxCost).toBe(23_000_000_000_000_000n);
  });

  it("applies a sponsorship onto the operation", async () => {
    const {fn} = stubFetch({body: response});
    const client = new PaymasterClient({endpoint: "https://pm.example.com", chainId: 8453, transport: {fetch: fn}});

    const sponsored = await client.applySponsorshipTo(op());
    expect(sponsored.paymaster).toBe(PAYMASTER);
    expect(sponsored.paymasterVerificationGasLimit).toBe(300_000n);
    expect(sponsored.paymasterData).toBe("0xcafe");
  });

  it("throws HttpApiError on a denial, surfacing the code", async () => {
    const {fn} = stubFetch({status: 403, body: {error: "SPONSORSHIP_DENIED", code: "SENDER_BLOCKED"}});
    const client = new PaymasterClient({endpoint: "https://pm.example.com", chainId: 8453, transport: {fetch: fn}});

    await expect(client.sponsor(op())).rejects.toMatchObject({
      name: "HttpApiError",
      status: 403,
      errorCode: "SENDER_BLOCKED",
    });
  });

  it("does not send an Authorization header when no key is configured", async () => {
    const {fn, calls} = stubFetch({body: response});
    const client = new PaymasterClient({endpoint: "https://pm.example.com", chainId: 8453, transport: {fetch: fn}});
    await client.sponsor(op());
    expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBeUndefined();
  });
});

describe("BundlerClient", () => {
  it("unwraps a JSON-RPC result", async () => {
    const {fn} = stubFetch({body: {jsonrpc: "2.0", id: 1, result: [ENTRY_POINT]}});
    const client = new BundlerClient({endpoint: "https://bundler.example.com", transport: {fetch: fn}});
    expect(await client.supportedEntryPoints()).toEqual([ENTRY_POINT]);
  });

  it("throws JsonRpcError with the code on an RPC error", async () => {
    const {fn} = stubFetch({body: {jsonrpc: "2.0", id: 1, error: {code: -32502, message: "stake too low"}}});
    const client = new BundlerClient({endpoint: "https://bundler.example.com", transport: {fetch: fn}});

    await expect(client.sendUserOperation(op(), ENTRY_POINT)).rejects.toMatchObject({
      name: "JsonRpcError",
      code: -32502,
    });
  });

  it("converts hex quantities in a receipt to bigint", async () => {
    const {fn} = stubFetch({
      body: {
        jsonrpc: "2.0",
        id: 1,
        result: {
          userOpHash: "0xhash",
          sender: SENDER,
          success: true,
          actualGasCost: "0x2386f26fc10000",
          actualGasUsed: "0x30d40",
          receipt: {transactionHash: "0xtx", blockNumber: "0x10"},
        },
      },
    });
    const client = new BundlerClient({endpoint: "https://bundler.example.com", transport: {fetch: fn}});

    const receipt = await client.getUserOperationReceipt("0xhash" as Hex);
    expect(receipt?.actualGasCost).toBe(10_000_000_000_000_000n);
    expect(receipt?.blockNumber).toBe(16n);
    expect(receipt?.success).toBe(true);
  });

  it("returns null for an unmined operation", async () => {
    const {fn} = stubFetch({body: {jsonrpc: "2.0", id: 1, result: null}});
    const client = new BundlerClient({endpoint: "https://bundler.example.com", transport: {fetch: fn}});
    expect(await client.getUserOperationReceipt("0xhash" as Hex)).toBeNull();
  });
});

describe("error types are distinguishable", () => {
  it("JsonRpcError and HttpApiError are separate types a caller can branch on", () => {
    expect(new JsonRpcError(-32000, "x")).toBeInstanceOf(JsonRpcError);
    expect(new HttpApiError(403, "DENIED", "x")).toBeInstanceOf(HttpApiError);
    expect(new JsonRpcError(-32000, "x")).not.toBeInstanceOf(HttpApiError);
  });
});
