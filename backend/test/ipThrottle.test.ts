import {describe, expect, it} from "vitest";

import {InMemoryQuotaStore} from "../src/policy/quota/inMemoryQuotaStore.js";
import {IpThrottle} from "../src/security/ipThrottle.js";
import type {Alert, Alerter} from "../src/monitoring/alerting.js";

const OPTS = {requestsPerWindow: 5, windowSeconds: 60, authFailureThreshold: 3, blockWindowSeconds: 900};
const IP = "203.0.113.7";
const NOW = 1_700_000_000;

function capturing(): {alerter: Alerter; fired: Alert[]} {
  const fired: Alert[] = [];
  return {alerter: {fire: (a) => void fired.push(a), resolve: () => {}}, fired};
}

describe("IpThrottle", () => {
  it("allows requests up to the per-window limit, then throttles", async () => {
    const t = new IpThrottle(new InMemoryQuotaStore(), OPTS);
    for (let i = 0; i < 5; i++) expect((await t.check(IP, NOW)).allowed).toBe(true);
    const sixth = await t.check(IP, NOW);
    expect(sixth).toMatchObject({allowed: false, reason: "throttled"});
    if (!sixth.allowed) expect(sixth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("scopes the rate limit per IP", async () => {
    const t = new IpThrottle(new InMemoryQuotaStore(), OPTS);
    for (let i = 0; i < 5; i++) await t.check(IP, NOW);
    // A different IP is unaffected.
    expect((await t.check("198.51.100.9", NOW)).allowed).toBe(true);
  });

  it("resets the rate limit in the next window", async () => {
    const t = new IpThrottle(new InMemoryQuotaStore(), OPTS);
    for (let i = 0; i < 5; i++) await t.check(IP, NOW);
    expect((await t.check(IP, NOW)).allowed).toBe(false);
    expect((await t.check(IP, NOW + 60)).allowed).toBe(true);
  });

  it("blocks an IP after the auth-failure threshold, rejecting even before the rate limit", async () => {
    const t = new IpThrottle(new InMemoryQuotaStore(), OPTS);
    for (let i = 0; i < 3; i++) await t.recordAuthFailure(IP, NOW);
    const decision = await t.check(IP, NOW);
    expect(decision).toMatchObject({allowed: false, reason: "blocked"});
  });

  it("does not block below the threshold", async () => {
    const t = new IpThrottle(new InMemoryQuotaStore(), OPTS);
    await t.recordAuthFailure(IP, NOW);
    await t.recordAuthFailure(IP, NOW);
    expect((await t.check(IP, NOW)).allowed).toBe(true);
  });

  it("lifts the block once the block window rolls over", async () => {
    const t = new IpThrottle(new InMemoryQuotaStore(), OPTS);
    for (let i = 0; i < 3; i++) await t.recordAuthFailure(IP, NOW);
    expect((await t.check(IP, NOW)).allowed).toBe(false);
    expect((await t.check(IP, NOW + 900)).allowed).toBe(true);
  });

  it("fires exactly one alert on the blocking transition", async () => {
    const {alerter, fired} = capturing();
    const t = new IpThrottle(new InMemoryQuotaStore(), OPTS, alerter);
    for (let i = 0; i < 5; i++) await t.recordAuthFailure(IP, NOW); // two past the threshold
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({key: `ip-blocked:${IP}`, severity: "warning"});
  });
});
