import {Logger, type OnApplicationBootstrap, type OnApplicationShutdown} from "@nestjs/common";

/**
 * A long-running loop with an explicit lifecycle.
 *
 * `start` is called once the app is listening; `stop` once it is shutting down. Implementations own
 * their own timer — the host only sequences start/stop — because each loop knows its own cadence and
 * how to make its tick reentrancy-safe.
 */
export interface BackgroundService {
  readonly name: string;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

/**
 * Runs the background services alongside the HTTP app and ties their lifecycle to Nest's.
 *
 * Registered as a value provider, so Nest calls `onApplicationBootstrap`/`onApplicationShutdown` on
 * it exactly as it would on a decorated provider — which is what lets these loops start after the
 * server is ready and, crucially, be stopped on SIGTERM so a rolling deploy does not leave orphaned
 * timers polling chains from a dying pod.
 *
 * A service that throws on start is logged and skipped, not fatal: a broken deposit monitor must not
 * take the sponsorship API down with it. Stop is always attempted for every started service.
 */
export class BackgroundServiceHost implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly #services: readonly BackgroundService[];
  readonly #started = new Set<BackgroundService>();
  readonly #logger = new Logger("background");

  constructor(services: readonly BackgroundService[]) {
    this.#services = services;
  }

  async onApplicationBootstrap(): Promise<void> {
    for (const service of this.#services) {
      try {
        await service.start();
        this.#started.add(service);
        this.#logger.log(`started ${service.name}`);
      } catch (error) {
        this.#logger.error(`failed to start ${service.name}: ${message(error)}`);
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    for (const service of this.#started) {
      try {
        await service.stop();
      } catch (error) {
        this.#logger.error(`failed to stop ${service.name}: ${message(error)}`);
      }
    }
    this.#started.clear();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
