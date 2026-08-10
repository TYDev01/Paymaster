/**
 * A per-target circuit breaker for outbound calls (here: chain RPC).
 *
 * The problem it solves: when an RPC endpoint goes down, every request keeps trying it, waits out the
 * timeout, and fails — turning one dead dependency into slow failures across the whole service, and
 * hammering an endpoint that is already struggling. The breaker trips after a run of failures and
 * then fails FAST for a cooldown, so a dead chain costs a rejected call instead of a timeout, and the
 * endpoint gets breathing room to recover.
 *
 * Three states, the standard model:
 *   closed    — calls flow; consecutive failures are counted.
 *   open      — calls are rejected immediately; after `openMs` it moves to half-open.
 *   half-open — a limited number of trial calls are allowed; a success closes it, a failure re-opens.
 *
 * Deliberately counts CONSECUTIVE failures, not a rate: a single success resets the count. That fits
 * RPC, where the failure mode is "the endpoint is down" (a solid run of failures), not "1% of calls
 * are bad". The clock is injected so the state machine is testable without real time.
 */
export type CircuitState = "closed" | "open" | "half-open";

export class CircuitOpenError extends Error {
  constructor(readonly circuit: string) {
    super(`circuit "${circuit}" is open`);
    this.name = "CircuitOpenError";
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures in `closed` that trip the breaker to `open`. */
  readonly failureThreshold: number;
  /** How long `open` lasts before a half-open trial is allowed, in ms. */
  readonly openMs: number;
  /** Trial calls permitted in `half-open` before it must decide. One is usually enough. */
  readonly halfOpenMaxCalls: number;
}

export interface CircuitStateChange {
  readonly circuit: string;
  readonly from: CircuitState;
  readonly to: CircuitState;
}

export class CircuitBreaker {
  readonly name: string;
  readonly #options: CircuitBreakerOptions;
  readonly #now: () => number;
  readonly #onStateChange: ((change: CircuitStateChange) => void) | undefined;

  #state: CircuitState = "closed";
  #consecutiveFailures = 0;
  #openedAt = 0;
  #halfOpenCalls = 0;

  constructor(
    name: string,
    options: CircuitBreakerOptions,
    hooks: {now?: () => number; onStateChange?: (change: CircuitStateChange) => void} = {},
  ) {
    this.name = name;
    this.#options = options;
    this.#now = hooks.now ?? (() => Date.now());
    this.#onStateChange = hooks.onStateChange;
  }

  get state(): CircuitState {
    // Resolve a lazy open→half-open transition so `state` never reads stale after the cooldown.
    if (this.#state === "open" && this.#now() - this.#openedAt >= this.#options.openMs) {
      this.#transition("half-open");
      this.#halfOpenCalls = 0;
    }
    return this.#state;
  }

  /**
   * Runs `fn` through the breaker.
   *
   * Rejects with `CircuitOpenError` WITHOUT calling `fn` when the breaker is open (or when half-open
   * and the trial budget is spent) — that is the fast-fail that protects a struggling endpoint. A
   * thrown result from `fn` counts as a failure; a returned value counts as a success.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state; // resolves the open→half-open transition
    if (state === "open") throw new CircuitOpenError(this.name);
    if (state === "half-open") {
      if (this.#halfOpenCalls >= this.#options.halfOpenMaxCalls) throw new CircuitOpenError(this.name);
      this.#halfOpenCalls += 1;
    }

    try {
      const result = await fn();
      this.#onSuccess();
      return result;
    } catch (error) {
      this.#onFailure();
      throw error;
    }
  }

  #onSuccess(): void {
    this.#consecutiveFailures = 0;
    if (this.#state !== "closed") this.#transition("closed");
  }

  #onFailure(): void {
    this.#consecutiveFailures += 1;
    // A failure during a half-open trial re-opens immediately; the endpoint is not back.
    if (this.#state === "half-open" || this.#consecutiveFailures >= this.#options.failureThreshold) {
      this.#openedAt = this.#now();
      this.#transition("open");
    }
  }

  #transition(to: CircuitState): void {
    if (this.#state === to) return;
    const from = this.#state;
    this.#state = to;
    this.#onStateChange?.({circuit: this.name, from, to});
  }
}
