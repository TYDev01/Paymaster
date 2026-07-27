import {describe, expect, it, vi} from "vitest";

import {CircuitBreaker, CircuitOpenError, type CircuitStateChange} from "../src/security/circuitBreaker.js";

const OPTS = {failureThreshold: 3, openMs: 1000, halfOpenMaxCalls: 1};

function ok() {
  return Promise.resolve("ok");
}
function boom(): Promise<never> {
  return Promise.reject(new Error("rpc down"));
}

describe("CircuitBreaker", () => {
  it("stays closed and passes results through while calls succeed", async () => {
    const cb = new CircuitBreaker("c", OPTS);
    expect(await cb.execute(ok)).toBe("ok");
    expect(cb.state).toBe("closed");
  });

  it("opens after the configured run of consecutive failures", async () => {
    const cb = new CircuitBreaker("c", OPTS, {now: () => 0});
    for (let i = 0; i < 3; i++) await expect(cb.execute(boom)).rejects.toThrow("rpc down");
    expect(cb.state).toBe("open");
  });

  it("fails fast without calling fn while open", async () => {
    const cb = new CircuitBreaker("c", OPTS, {now: () => 0});
    for (let i = 0; i < 3; i++) await expect(cb.execute(boom)).rejects.toThrow();
    const fn = vi.fn(ok);
    await expect(cb.execute(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("a single success resets the consecutive-failure count", async () => {
    const cb = new CircuitBreaker("c", OPTS, {now: () => 0});
    await expect(cb.execute(boom)).rejects.toThrow();
    await expect(cb.execute(boom)).rejects.toThrow();
    await cb.execute(ok); // resets
    await expect(cb.execute(boom)).rejects.toThrow();
    await expect(cb.execute(boom)).rejects.toThrow();
    expect(cb.state).toBe("closed"); // only 2 in a row since the reset
  });

  it("moves to half-open after the cooldown and closes on a successful trial", async () => {
    let clock = 0;
    const cb = new CircuitBreaker("c", OPTS, {now: () => clock});
    for (let i = 0; i < 3; i++) await expect(cb.execute(boom)).rejects.toThrow();
    expect(cb.state).toBe("open");

    clock = 1000; // cooldown elapsed
    expect(cb.state).toBe("half-open");
    expect(await cb.execute(ok)).toBe("ok");
    expect(cb.state).toBe("closed");
  });

  it("re-opens immediately if the half-open trial fails", async () => {
    let clock = 0;
    const cb = new CircuitBreaker("c", OPTS, {now: () => clock});
    for (let i = 0; i < 3; i++) await expect(cb.execute(boom)).rejects.toThrow();
    clock = 1000;
    expect(cb.state).toBe("half-open");
    await expect(cb.execute(boom)).rejects.toThrow("rpc down");
    expect(cb.state).toBe("open");
  });

  it("limits the number of trial calls in half-open", async () => {
    let clock = 0;
    const cb = new CircuitBreaker("c", {...OPTS, halfOpenMaxCalls: 1}, {now: () => clock});
    for (let i = 0; i < 3; i++) await expect(cb.execute(boom)).rejects.toThrow();
    clock = 1000;
    // First trial is allowed (and here it hangs as pending); a second concurrent trial is rejected.
    const trial = cb.execute(() => new Promise((resolve) => setTimeout(() => resolve("late"), 50)));
    await expect(cb.execute(ok)).rejects.toBeInstanceOf(CircuitOpenError);
    await trial;
  });

  it("emits state-change events for observability/alerting", async () => {
    const changes: CircuitStateChange[] = [];
    let clock = 0;
    const cb = new CircuitBreaker("base-rpc", OPTS, {now: () => clock, onStateChange: (c) => changes.push(c)});
    for (let i = 0; i < 3; i++) await expect(cb.execute(boom)).rejects.toThrow();
    clock = 1000;
    await cb.execute(ok);
    expect(changes.map((c) => `${c.from}->${c.to}`)).toEqual(["closed->open", "open->half-open", "half-open->closed"]);
    expect(changes[0]!.circuit).toBe("base-rpc");
  });
});
