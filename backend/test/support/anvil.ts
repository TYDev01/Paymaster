import {spawn, type ChildProcess} from "node:child_process";
import {readFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

import {createPublicClient, createWalletClient, defineChain, http, type Abi, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {anvil as anvilChain} from "viem/chains";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = resolve(HERE, "../../../contracts/out");

/**
 * Anvil's first well-known development account. This is a publicly documented test key shared by
 * every Foundry install — it is not a secret, and it controls nothing outside this ephemeral node.
 */
const DEV_ACCOUNT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

export interface Artifact {
  abi: Abi;
  bytecode: {object: Hex};
}

/**
 * Loads a compiled contract from Foundry's output.
 *
 * The tests read the *actual build artifacts* rather than a checked-in ABI copy. That is the whole
 * point of the differential suite: if the contract changes shape, these tests must see the change.
 */
export function loadArtifact(sol: string, name: string): Artifact {
  const path = resolve(ARTIFACTS, sol, `${name}.json`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Artifact;
  } catch (cause) {
    throw new Error(`Could not read artifact ${name} at ${path}. Run \`forge build\` in contracts/ first.`, {cause});
  }
}

export interface AnvilInstance {
  rpcUrl: string;
  /** The node's actual chain — 31337 locally, the forked chain's id when forking. */
  chain: ReturnType<typeof defineChain>;
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  deployer: Address;
  stop: () => void;
}

export interface AnvilOptions {
  /**
   * Fork a live chain at its current head. The node then has the REAL chain's state: the canonical
   * EntryPoint at its real address with its real code, real deployed accounts, real base fee. Slow
   * (every state read is an RPC round trip) and dependent on an external endpoint, so it is opt-in.
   */
  readonly forkUrl?: string | undefined;
  readonly forkBlockNumber?: bigint | undefined;
}

/** Starts an ephemeral anvil node on a random port and waits until it answers RPC. */
export async function startAnvil(options: AnvilOptions = {}): Promise<AnvilInstance> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const rpcUrl = `http://127.0.0.1:${port}`;

  const args = ["--port", String(port), "--silent"];
  if (options.forkUrl !== undefined) {
    args.push("--fork-url", options.forkUrl);
    if (options.forkBlockNumber !== undefined) args.push("--fork-block-number", String(options.forkBlockNumber));
  }

  const proc: ChildProcess = spawn("anvil", args, {
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const exited = new Promise<never>((_, reject) => {
    proc.once("exit", (code) => {
      reject(new Error(`anvil exited early (code ${code}): ${stderr || "<no stderr>"}`));
    });
  });

  const account = privateKeyToAccount(DEV_ACCOUNT_KEY);
  const transport = http(rpcUrl);

  // A fork has to fetch chain state before it can answer, over a public endpoint that may be slow.
  const probe = createPublicClient({transport});
  await Promise.race([waitForReady(probe, options.forkUrl === undefined ? 15_000 : 60_000), exited]);

  // Anvil adopts the FORKED chain's id, so the clients cannot assume 31337. Reading it back keeps
  // viem's chain-id check — and the EIP-712 domain the paymaster signs over — matching the node.
  const chain = defineChain({...anvilChain, id: await probe.getChainId()});
  const publicClient = createPublicClient({chain, transport});
  const walletClient = createWalletClient({account, chain, transport});

  return {
    rpcUrl,
    chain,
    publicClient,
    walletClient,
    deployer: account.address,
    stop: () => {
      proc.removeAllListeners("exit");
      proc.kill("SIGKILL");
    },
  };
}

async function waitForReady(client: ReturnType<typeof createPublicClient>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await client.getBlockNumber();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`anvil did not become ready within 15s: ${String(lastError)}`);
}

/** Deploys a contract and returns its address, failing loudly rather than returning undefined. */
export async function deploy(
  anvil: AnvilInstance,
  artifact: Artifact,
  args: readonly unknown[] = [],
): Promise<Address> {
  const hash = await anvil.walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: args as never,
    account: anvil.walletClient.account!,
    chain: anvil.chain,
  });
  const receipt = await anvil.publicClient.waitForTransactionReceipt({hash});
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`deployment reverted (status=${receipt.status})`);
  }
  return receipt.contractAddress;
}
