import {spawn, type ChildProcess} from "node:child_process";
import {existsSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

import type {Address, Hex} from "viem";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where the rundler binary is expected.
 *
 * Not vendored into the repo: it is a 56MB release artifact for one platform. CI and developers
 * fetch it with `npm run bundler:fetch`, which pins the version and records the checksum.
 */
export const RUNDLER_BIN = process.env["RUNDLER_BIN"] ?? resolve(HERE, "../../.bundler/rundler");

export function rundlerAvailable(): boolean {
  return existsSync(RUNDLER_BIN);
}

export interface BundlerInstance {
  readonly rpcUrl: string;
  readonly metricsUrl: string;
  stop: () => void;
  /** For diagnosing a rejection: rundler explains itself in its logs, not in the RPC error. */
  logs: () => string;
}

export interface StartBundlerOptions {
  readonly nodeHttp: string;
  readonly entryPoint: Address;
  readonly chainId: number;
  /** The EOA that submits bundles. Needs native balance on the target chain. */
  readonly builderKey: Hex;
  /**
   * Skips trace-based validation.
   *
   * Defaults to false, deliberately. Safe mode is what enforces the ERC-7562 storage rules, and
   * those rules are the entire reason our paymaster must be staked — running unsafe would skip the
   * check this harness exists to make.
   */
  readonly unsafe?: boolean;
}

/**
 * Starts a real rundler against a local node.
 *
 * This is the only harness in the suite that exercises what a bundler actually does: `handleOps`
 * called directly, as every other test does, skips simulation, storage-rule enforcement, mempool
 * admission, and bundle building. A paymaster can pass all of those tests and still be rejected by
 * every bundler in production.
 */
export async function startBundler(options: StartBundlerOptions): Promise<BundlerInstance> {
  if (!rundlerAvailable()) {
    throw new Error(`rundler not found at ${RUNDLER_BIN}. Run: npm run bundler:fetch`);
  }

  const rpcPort = 30_000 + Math.floor(Math.random() * 10_000);
  const metricsPort = rpcPort + 1;

  // Rundler's chain spec pins the EntryPoint per version. Overriding it is what lets a locally
  // deployed EntryPoint stand in for the canonical address.
  const specPath = join(tmpdir(), `rundler-spec-${rpcPort}.toml`);
  await writeFile(
    specPath,
    [
      'base = "ethereum"',
      'name = "Local Devnet"',
      `id = ${options.chainId}`,
      `entry_point_address_v0_7 = "${options.entryPoint}"`,
      "bundle_max_send_interval_millis = 250",
      "block_gas_limit = 30000000",
      "flashbots_enabled = false",
      "eip7702_enabled = false",
      "",
    ].join("\n"),
  );

  const args = [
    "node",
    "--chain_spec",
    specPath,
    "--node_http",
    options.nodeHttp,
    "--signer.private_keys",
    options.builderKey,
    "--enabled_entry_points",
    "v0.7",
    "--rpc.port",
    String(rpcPort),
    "--rpc.host",
    "127.0.0.1",
    "--metrics.port",
    String(metricsPort),
    // One op per bundle: a test asserting "our op landed" should not depend on what else the
    // builder decided to batch with it.
    "--builder.max_bundle_size",
    "1",
  ];
  if (options.unsafe === true) args.push("--unsafe");

  const proc: ChildProcess = spawn(RUNDLER_BIN, args, {stdio: ["ignore", "pipe", "pipe"]});

  let output = "";
  proc.stdout?.on("data", (c: Buffer) => (output += c.toString()));
  proc.stderr?.on("data", (c: Buffer) => (output += c.toString()));

  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const exited = new Promise<never>((_, reject) => {
    proc.once("exit", (code) => reject(new Error(`rundler exited early (code ${code}):\n${output}`)));
  });

  await Promise.race([waitForRpc(rpcUrl, options.entryPoint), exited]);

  return {
    rpcUrl,
    metricsUrl: `http://127.0.0.1:${metricsPort}/metrics`,
    stop: () => {
      proc.removeAllListeners("exit");
      proc.kill("SIGKILL");
    },
    logs: () => output,
  };
}

/** Ready means it answers eth_supportedEntryPoints with the EntryPoint we told it about. */
async function waitForRpc(rpcUrl: string, entryPoint: Address): Promise<void> {
  const deadline = Date.now() + 30_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "eth_supportedEntryPoints", params: []}),
      });
      const body = (await response.json()) as {result?: string[]};
      if (body.result?.some((e) => e.toLowerCase() === entryPoint.toLowerCase()) === true) return;
      last = JSON.stringify(body);
    } catch (error) {
      last = String(error);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`rundler did not become ready within 30s. Last: ${last}`);
}

/** A JSON-RPC call to the bundler, returning result or error rather than throwing on error. */
export async function bundlerRpc<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<{result?: T; error?: {code: number; message: string; data?: unknown}}> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}),
  });
  return (await response.json()) as {result?: T; error?: {code: number; message: string}};
}
