import {Logger} from "@nestjs/common";

/**
 * Cross-replica policy invalidation, as a port.
 *
 * The gap this closes is a real one, and it is invisible on a single replica. `PolicySource` holds
 * the policy set in memory and swaps it on `reload()`. Reload runs at startup and when an admin
 * request lands — on the ONE replica that served that request. Every other replica keeps serving
 * the previous policy set indefinitely, so behind a load balancer an operator who adds a sender to
 * a blocklist has blocked that sender on a third of their traffic, and cannot tell from the
 * response which third.
 *
 * A change is therefore announced here and every replica reloads. Two properties matter:
 *
 *   * It carries NO PAYLOAD. The message says "the policy set changed", not what it changed to.
 *     Each replica re-reads Postgres, which is already the source of truth — shipping policy
 *     contents through a cache would create a second one that can disagree with it.
 *   * It is BEST-EFFORT, and paired with a timer. Pub/sub has no delivery guarantee: a replica that
 *     is reconnecting when the message is published never sees it. `PolicyReloader` therefore also
 *     reloads on an interval, so the broadcast is a latency optimisation over a mechanism that is
 *     correct without it, rather than the mechanism itself.
 */
export interface PolicyBroadcast {
  /** Announces that the policy set changed. Never throws — see the implementations. */
  publish(): Promise<void>;
  /** Registers a handler for announcements from OTHER replicas. Called once, at startup. */
  subscribe(onChange: () => void): Promise<void>;
  close(): Promise<void>;
}

/**
 * The single-replica implementation: there is no one to tell.
 *
 * Used when Redis is absent, which is the same condition under which quotas are process-local —
 * a deployment already documented as single-instance. Returning a working no-op rather than
 * `undefined` keeps the reload path free of null checks.
 */
export class NoopPolicyBroadcast implements PolicyBroadcast {
  async publish(): Promise<void> {}
  async subscribe(): Promise<void> {}
  async close(): Promise<void> {}
}

/** The slice of a Redis client this needs. Structural, so the port does not depend on ioredis. */
export interface RedisPubSubClient {
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(channel: string): Promise<unknown>;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
  quit(): Promise<unknown>;
}

export const POLICY_CHANNEL = "paymaster:policy:changed";

export class RedisPolicyBroadcast implements PolicyBroadcast {
  readonly #publisher: RedisPubSubClient;
  readonly #createSubscriber: () => RedisPubSubClient;
  readonly #channel: string;
  readonly #logger = new Logger("policy");
  #subscriber: RedisPubSubClient | undefined;

  /**
   * @param publisher        the shared client; publishing is an ordinary command.
   * @param createSubscriber makes a SECOND connection. A Redis connection in subscriber mode
   *                         accepts only subscribe/unsubscribe commands, so reusing the shared
   *                         client here would break every quota operation on it.
   */
  constructor(
    publisher: RedisPubSubClient,
    createSubscriber: () => RedisPubSubClient,
    channel: string = POLICY_CHANNEL,
  ) {
    this.#publisher = publisher;
    this.#createSubscriber = createSubscriber;
    this.#channel = channel;
  }

  async publish(): Promise<void> {
    try {
      await this.#publisher.publish(this.#channel, String(Date.now()));
    } catch (error) {
      // The admin write already succeeded and this replica has already reloaded. Failing the
      // request now would tell the operator their change did not apply, which is false — the
      // other replicas simply pick it up on their next timed reload instead.
      this.#logger.warn(`could not announce policy change: ${message(error)}; peers will reload on their timer`);
    }
  }

  async subscribe(onChange: () => void): Promise<void> {
    const subscriber = this.#createSubscriber();
    subscriber.on("message", (channel) => {
      if (channel === this.#channel) onChange();
    });
    await subscriber.subscribe(this.#channel);
    this.#subscriber = subscriber;
  }

  async close(): Promise<void> {
    await this.#subscriber?.quit();
    this.#subscriber = undefined;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
