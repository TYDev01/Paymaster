import {describe, expect, it, vi} from "vitest";

import {NoopPolicyBroadcast, RedisPolicyBroadcast, type RedisPubSubClient} from "../src/policy/policyBroadcast.js";
import {PolicyReloader} from "../src/policy/policyReloader.js";
import {PolicySource} from "../src/policy/policySource.js";
import type {Policy} from "../src/policy/engine.js";
import {AlwaysLeader, RedisLeaderLock, type RedisLockClient} from "../src/monitoring/leaderLock.js";
import {LeaderOnlyAlerter} from "../src/monitoring/leaderAlerter.js";
import type {Alert, Alerter} from "../src/monitoring/alerting.js";

/** An in-memory pub/sub pair standing in for Redis: publish reaches every OTHER subscriber. */
function pubsub(): {client: () => RedisPubSubClient; published: string[]} {
  const listeners: ((channel: string, message: string) => void)[] = [];
  const published: string[] = [];
  const client = (): RedisPubSubClient => ({
    publish: async (channel, message) => {
      published.push(channel);
      for (const listener of listeners) listener(channel, message);
      return listeners.length;
    },
    subscribe: async () => 1,
    on: (_event, listener) => listeners.push(listener),
    quit: async () => "OK",
  });
  return {client, published};
}

function sourceOf(policies: Policy[]): {source: PolicySource; loads: () => number} {
  let loads = 0;
  const source = new PolicySource({
    load: async () => {
      loads += 1;
      return policies;
    },
  });
  return {source, loads: () => loads};
}

const policy = (id: string): Policy => ({id, rules: []});

describe("policy propagation across replicas", () => {
  it("reloads a peer when a change is announced", async () => {
    const {client} = pubsub();
    const shared = client();

    const publisher = new RedisPolicyBroadcast(shared, () => shared, "ch");
    const subscriberSide = new RedisPolicyBroadcast(shared, () => shared, "ch");

    // The "other replica": subscribed, holding a stale set.
    const policies = [policy("a")];
    const {source, loads} = sourceOf(policies);
    const reloader = new PolicyReloader(source, subscriberSide, {intervalMs: 3_600_000, coalesceMs: 1});
    await reloader.start();
    expect(loads()).toBe(1); // the immediate tick at start

    // A change lands on the admin replica.
    policies.push(policy("b"));
    await publisher.publish();
    await vi.waitFor(() => expect(source.has("b")).toBe(true));

    await reloader.stop();
  });

  it("coalesces a burst of announcements into one reload", async () => {
    const {client} = pubsub();
    const shared = client();
    const broadcast = new RedisPolicyBroadcast(shared, () => shared, "ch");

    const {source, loads} = sourceOf([policy("a")]);
    const reloader = new PolicyReloader(source, broadcast, {intervalMs: 3_600_000, coalesceMs: 20});
    await reloader.start();
    const afterStart = loads();

    // Ten policies upserted by a script would otherwise be ten full reloads, on every replica, at
    // once — nine of them redundant and all of them hitting Postgres simultaneously.
    for (let i = 0; i < 10; i++) await broadcast.publish();
    await vi.waitFor(() => expect(loads()).toBe(afterStart + 1));

    await reloader.stop();
  });

  it("keeps converging when the broadcast never arrives", async () => {
    // The correctness guarantee: no pub/sub at all, and the replica still picks the change up.
    const policies = [policy("a")];
    const {source, loads} = sourceOf(policies);
    const reloader = new PolicyReloader(source, new NoopPolicyBroadcast(), {intervalMs: 20});
    await reloader.start();

    policies.push(policy("b"));
    await vi.waitFor(() => expect(source.has("b")).toBe(true));
    expect(loads()).toBeGreaterThan(1);

    await reloader.stop();
  });

  it("does not fail an admin write when the announcement cannot be delivered", async () => {
    const broken: RedisPubSubClient = {
      publish: async () => {
        throw new Error("redis down");
      },
      subscribe: async () => 1,
      on: () => undefined,
      quit: async () => "OK",
    };

    // The write already succeeded and this replica already reloaded; peers converge on their timer.
    await expect(new RedisPolicyBroadcast(broken, () => broken).publish()).resolves.toBeUndefined();
  });

  it("serialises overlapping reloads so the newest state wins", async () => {
    let resolveFirst: (() => void) | undefined;
    let call = 0;
    const seen: string[] = [];
    const source = new PolicySource({
      load: async () => {
        call += 1;
        if (call === 1) await new Promise<void>((resolve) => (resolveFirst = resolve));
        seen.push(`load${call}`);
        return [policy(`gen${call}`)];
      },
    });
    const reloader = new PolicyReloader(source, new NoopPolicyBroadcast(), {intervalMs: 3_600_000});

    const first = reloader.reloadNow();
    const second = reloader.reloadNow(); // arrives while the first is in flight
    resolveFirst?.();
    await Promise.all([first, second]);

    // The second did not run concurrently; it ran after, so the later state is the one installed.
    expect(seen).toEqual(["load1", "load2"]);
    expect(source.has("gen2")).toBe(true);
  });
});

describe("RedisLeaderLock", () => {
  /** A minimal Redis standing in for SET NX PX and the two Lua scripts. */
  function fakeRedis(): RedisLockClient & {store: Map<string, string>} {
    const store = new Map<string, string>();
    return {
      store,
      set: async (key, value, _mode, _ttl, _condition) => {
        if (store.has(key)) return null;
        store.set(key, value);
        return "OK";
      },
      eval: async (script, _numKeys, key, holder) => {
        const held = store.get(key!) === holder;
        if (!held) return 0;
        if (script.includes("DEL")) store.delete(key!);
        return 1;
      },
    };
  }

  it("grants leadership to exactly one of several contenders", async () => {
    const redis = fakeRedis();
    const options = {key: "leader", ttlMs: 30_000};
    const a = new RedisLeaderLock(redis, {...options, holder: "a"});
    const b = new RedisLeaderLock(redis, {...options, holder: "b"});

    expect(await a.tryAcquire()).toBe(true);
    expect(await b.tryAcquire()).toBe(false);
    expect(a.isLeader).toBe(true);
    expect(b.isLeader).toBe(false);
  });

  it("hands over on release, so a rolling deploy does not wait out the lease", async () => {
    const redis = fakeRedis();
    const options = {key: "leader", ttlMs: 30_000};
    const a = new RedisLeaderLock(redis, {...options, holder: "a"});
    const b = new RedisLeaderLock(redis, {...options, holder: "b"});

    await a.tryAcquire();
    await a.release();

    expect(a.isLeader).toBe(false);
    expect(await b.tryAcquire()).toBe(true);
  });

  it("steps down when its lease was taken over", async () => {
    const redis = fakeRedis();
    const a = new RedisLeaderLock(redis, {key: "leader", holder: "a", ttlMs: 30_000});
    await a.tryAcquire();

    // Simulates the lease expiring during a stall and another replica taking it.
    redis.store.set("leader", "b");

    expect(await a.tryAcquire()).toBe(false);
    expect(a.isLeader).toBe(false);
  });

  it("steps down rather than assuming leadership when Redis is unreachable", async () => {
    const broken: RedisLockClient = {
      set: async () => {
        throw new Error("redis down");
      },
      eval: async () => {
        throw new Error("redis down");
      },
    };
    const lock = new RedisLeaderLock(broken, {key: "leader", holder: "a", ttlMs: 30_000});

    expect(await lock.tryAcquire()).toBe(false);
    expect(lock.isLeader).toBe(false);
  });
});

describe("LeaderOnlyAlerter", () => {
  function recordingAlerter(): Alerter & {fired: string[]; resolved: string[]} {
    const fired: string[] = [];
    const resolved: string[] = [];
    return {fired, resolved, fire: (a: Alert) => void fired.push(a.key), resolve: (k: string) => void resolved.push(k)};
  }

  const alert: Alert = {key: "deposit-low:8453", severity: "critical", title: "t", detail: "d"};

  it("delivers from the leader", async () => {
    const inner = recordingAlerter();
    await new LeaderOnlyAlerter(inner, new AlwaysLeader()).fire(alert);
    expect(inner.fired).toEqual(["deposit-low:8453"]);
  });

  it("suppresses both fire and resolve on a follower", async () => {
    const inner = recordingAlerter();
    const follower = new LeaderOnlyAlerter(inner, {
      isLeader: false,
      tryAcquire: async () => false,
      release: async () => {},
    });

    await follower.fire(alert);
    // Resolve is gated too: a follower closing an incident the leader still holds open would leave
    // it closed and un-refired, because the leader's own gate still reads as firing.
    await follower.resolve(alert.key);

    expect(inner.fired).toEqual([]);
    expect(inner.resolved).toEqual([]);
  });
});
