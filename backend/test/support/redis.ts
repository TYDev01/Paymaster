import {spawn, type ChildProcess} from "node:child_process";

import Redis from "ioredis";

export interface TestRedis {
  readonly redis: Redis;
  readonly port: number;
  stop: () => Promise<void>;
}

/**
 * Starts a disposable Redis on a random loopback port.
 *
 * A real server, not a fake: the whole point of this adapter is Lua script atomicity and INCRBY's
 * int64 behaviour, neither of which an in-memory imitation reproduces — and both of which are
 * exactly what could be wrong. Persistence is off; this data is disposable and fsync would only
 * slow the suite down. Never touches an existing installation.
 */
export async function startRedis(): Promise<TestRedis> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);

  const proc: ChildProcess = spawn(
    "redis-server",
    ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"],
    {stdio: ["ignore", "ignore", "pipe"]},
  );

  let stderr = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const exited = new Promise<never>((_, reject) => {
    proc.once("exit", (code) => reject(new Error(`redis-server exited early (code ${code}): ${stderr}`)));
  });

  // Wait for the port at the socket level BEFORE constructing the client: ioredis rejects a second
  // connect() on a client already connecting, so retrying connect() in a loop cannot work.
  await Promise.race([waitForPort(port), exited]);

  const redis = new Redis({host: "127.0.0.1", port, maxRetriesPerRequest: 2});
  await redis.ping();

  return {
    redis,
    port,
    stop: async () => {
      proc.removeAllListeners("exit");
      // quit() before killing the server: disconnect() alone leaves ioredis retrying against a
      // dead port, which surfaces as unhandled error events after the suite finishes.
      await redis.quit().catch(() => redis.disconnect());
      proc.kill("SIGKILL");
    },
  };
}

async function waitForPort(port: number): Promise<void> {
  const {connect} = await import("node:net");
  const deadline = Date.now() + 15_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connect({host: "127.0.0.1", port});
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`redis did not accept connections within 15s: ${String(lastError)}`);
}
