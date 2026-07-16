import {spawn, type ChildProcess} from "node:child_process";
import {readFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

import {createPublicClient, createWalletClient, http, type Abi, type Address, type Hex} from "viem";
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
    throw new Error(
      `Could not read artifact ${name} at ${path}. Run \`forge build\` in contracts/ first.`,
      {cause},
    );
  }
}

export interface AnvilInstance {
  rpcUrl: string;
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  deployer: Address;
  stop: () => void;
}

/** Starts an ephemeral anvil node on a random port and waits until it answers RPC. */
export async function startAnvil(): Promise<AnvilInstance> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const rpcUrl = `http://127.0.0.1:${port}`;

  const proc: ChildProcess = spawn("anvil", ["--port", String(port), "--silent"], {
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
  const publicClient = createPublicClient({chain: anvilChain, transport});
  const walletClient = createWalletClient({account, chain: anvilChain, transport});

  await Promise.race([waitForReady(publicClient), exited]);

  return {
    rpcUrl,
    publicClient,
    walletClient,
    deployer: account.address,
    stop: () => {
      proc.removeAllListeners("exit");
      proc.kill("SIGKILL");
    },
  };
}

async function waitForReady(client: ReturnType<typeof createPublicClient>): Promise<void> {
  const deadline = Date.now() + 15_000;
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
    chain: anvilChain,
  });
  const receipt = await anvil.publicClient.waitForTransactionReceipt({hash});
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`deployment reverted (status=${receipt.status})`);
  }
  return receipt.contractAddress;
}
