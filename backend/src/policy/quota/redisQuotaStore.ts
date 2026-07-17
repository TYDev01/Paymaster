import type {Redis} from "ioredis";

import {
  windowedKey,
  windowEnd,
  type QuotaConsumeParams,
  type QuotaOutcome,
  type QuotaReleaseParams,
  type QuotaStore,
} from "./quotaStore.js";

/**
 * Atomically consume budget, or refuse.
 *
 * This is the reason the QuotaStore port exposes `tryConsume` rather than get/set. A Lua script
 * runs to completion on the server with no other command interleaved, so the read, the comparison
 * and the increment are one indivisible step across every replica. The equivalent client-side
 * GET-then-INCRBY grants the last unit of budget to every concurrent request that reads before any
 * of them writes — a mutation of the in-memory store with a single `await` inserted between check
 * and increment grants 50 requests against a limit of 5.
 *
 * `EXPIRE ... NX` sets the TTL only when the key has none. Re-arming it on every increment would
 * slide the window forward for as long as a caller keeps spending, so a busy key would never
 * reset. Requires Redis >= 7.0 for the NX flag.
 */
const CONSUME_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1])) or 0
local amount = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

if current + amount > limit then
  return {0, tostring(current)}
end

local updated = redis.call('INCRBY', KEYS[1], amount)
redis.call('EXPIRE', KEYS[1], ttl, 'NX')
return {1, tostring(updated)}
`;

/**
 * Return budget taken by a request that was ultimately refused.
 *
 * Clamped at zero rather than allowed to go negative: a release arriving after its window rolled
 * over would otherwise push the NEW window's counter below zero and hand out free budget. Deleting
 * at zero also keeps a released-to-empty key from lingering without a TTL.
 */
const RELEASE_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1])) or 0
local amount = tonumber(ARGV[1])

if current <= amount then
  redis.call('DEL', KEYS[1])
  return '0'
end
return tostring(redis.call('DECRBY', KEYS[1], amount))
`;

/**
 * Extra life given to a counter beyond the end of its window.
 *
 * The key is namespaced by window start, so an expired key is simply unreachable — the TTL is only
 * housekeeping. The buffer absorbs clock skew between replicas, which would otherwise let a
 * slightly-fast replica expire a window a slightly-slow one is still writing to.
 */
const TTL_BUFFER_SECONDS = 60;

/**
 * Quota counters in Redis. This is what makes quotas correct across replicas.
 *
 * The in-memory store is race-free only within one process; with N replicas each caller gets N
 * times their quota. This one is shared, so the limit means what it says however many instances
 * are running.
 *
 * Values are counted in units that fit a signed 64-bit integer — operations, or gwei. Never wei:
 * `INCRBY` overflows at 9.22e18, which is 9.22 ETH. See WEI_PER_GWEI in quotaRules.ts.
 */
export class RedisQuotaStore implements QuotaStore {
  constructor(private readonly redis: Redis) {}

  async tryConsume(params: QuotaConsumeParams): Promise<QuotaOutcome> {
    const {key, amount, limit, windowSeconds, now} = params;
    const slot = windowedKey(key, windowSeconds, now);
    const resetsAt = windowEnd(now, windowSeconds);
    const ttl = Math.max(1, resetsAt - now + TTL_BUFFER_SECONDS);

    // ioredis caches the script and uses EVALSHA, falling back to EVAL on NOSCRIPT — so the script
    // body is not shipped on every call.
    const [consumed, usage] = (await this.redis.eval(
      CONSUME_SCRIPT,
      1,
      slot,
      amount.toString(),
      limit.toString(),
      String(ttl),
    )) as [number, string];

    return {consumed: consumed === 1, usage: BigInt(usage), limit, resetsAt};
  }

  async release(params: QuotaReleaseParams): Promise<void> {
    const {key, amount, windowSeconds, now} = params;
    await this.redis.eval(RELEASE_SCRIPT, 1, windowedKey(key, windowSeconds, now), amount.toString());
  }

  async usage(key: string, windowSeconds: number, now: number): Promise<bigint> {
    const value = await this.redis.get(windowedKey(key, windowSeconds, now));
    return value === null ? 0n : BigInt(value);
  }
}
