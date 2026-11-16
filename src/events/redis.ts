import type { RedisClientType } from "redis";
import type { Log } from "../platform/log.ts";
import type { EventBus, LossReason, ServiceEvent } from "./types.ts";

const CHANNEL = "tableau-data-app-service:events:v1";
const COMMAND_TIMEOUT_MS = 5_000;

/**
 * Redis publish and subscribe fan-out. The `redis` module is imported only when this bus starts,
 * so an installation with events off never loads it or opens a connection.
 */
export class RedisEventBus implements EventBus {
  readonly #url: string;
  readonly #log: Log;
  #publisher: RedisClientType | undefined;
  #subscriber: RedisClientType | undefined;
  #subscribed = false;
  #subscribing: Promise<void> | undefined;
  #wasReady = false;
  #handlers: { onEvent(event: ServiceEvent): void; onLoss(reason: LossReason): void } | undefined;

  constructor(options: { url: string; log: Log }) {
    this.#url = options.url;
    this.#log = options.log;
  }

  get ready(): boolean {
    return (
      this.#subscribed && Boolean(this.#subscriber?.isReady) && Boolean(this.#publisher?.isReady)
    );
  }

  async start(handlers: {
    onEvent(event: ServiceEvent): void;
    onLoss(reason: LossReason): void;
  }): Promise<void> {
    this.#handlers = handlers;
    const { createClient } = await import("redis");
    const make = () =>
      createClient({
        url: this.#url,
        disableOfflineQueue: true,
        socket: {
          connectTimeout: COMMAND_TIMEOUT_MS,
          reconnectStrategy: (retries: number) => Math.min(2_000, 100 * 2 ** Math.min(retries, 4)),
        },
      }) as RedisClientType;
    this.#publisher = make();
    this.#subscriber = make();
    for (const client of [this.#publisher, this.#subscriber]) {
      client.on("error", (error: unknown) => {
        this.#log.warn("redis error", { error });
        this.#changed();
      });
      client.on("end", () => this.#changed());
      client.on("ready", () => {
        // node-redis resubscribes after a reconnect; this covers a subscribe that never succeeded.
        void this.#subscribe()
          .catch((error: unknown) => this.#log.warn("redis subscribe failed", { error }))
          .finally(() => this.#changed());
      });
    }
    // connect() keeps retrying while Redis is unreachable, so startup does not wait for it: the
    // ready handlers subscribe and report readiness, and events resume whenever Redis is back.
    for (const client of [this.#publisher, this.#subscriber])
      client.connect().catch((error: unknown) => this.#log.warn("redis connect failed", { error }));
  }

  /** Single-flight: the ready handler and start may both ask, and a second listener would duplicate events. */
  async #subscribe(): Promise<void> {
    if (this.#subscribed || !this.#subscriber?.isReady) return;
    this.#subscribing ??= this.#listen().finally(() => {
      this.#subscribing = undefined;
    });
    await this.#subscribing;
  }

  async #listen(): Promise<void> {
    const subscriber = this.#subscriber;
    if (!subscriber) return;
    await subscriber.subscribe(CHANNEL, (message) => {
      let event: ServiceEvent;
      try {
        event = JSON.parse(message) as ServiceEvent;
      } catch {
        this.#log.warn("redis event unreadable");
        return;
      }
      this.#handlers?.onEvent(event);
    });
    this.#subscribed = true;
  }

  /** Reports loss on every transition: down means fan-out stopped, up means events may have been missed. */
  #changed(): void {
    const ready = this.ready;
    if (ready === this.#wasReady) return;
    this.#wasReady = ready;
    this.#log.info(ready ? "event fan-out ready" : "event fan-out unavailable");
    this.#handlers?.onLoss(ready ? "fan-out-reconnected" : "fan-out-unavailable");
  }

  async publish(event: ServiceEvent): Promise<void> {
    if (!this.#publisher?.isReady) throw new Error("event fan-out is unavailable");
    await this.#publisher.publish(CHANNEL, JSON.stringify(event));
  }

  async close(): Promise<void> {
    this.#handlers = undefined;
    // A client still trying to reach Redis has nothing to flush, so it is destroyed instead.
    await Promise.allSettled(
      [this.#publisher, this.#subscriber].map(async (client) => {
        if (client?.isReady) await client.close();
        else client?.destroy();
      }),
    );
    this.#publisher = undefined;
    this.#subscriber = undefined;
    this.#subscribed = false;
  }
}
