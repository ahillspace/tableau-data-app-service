import type { RedisClientType } from "redis";
import { opaqueId } from "../public/schemas.js";
import { decodeEnvelope, type EventLimits, eventBudgets, type LiveEnvelope } from "./protocol.js";

export type RedisEventsOptions = {
  channelScope: string;
  publishUrl: string;
  subscribeUrl: string;
  commandTimeoutMs: number;
};
export class RedisEvents {
  #publisher: RedisClientType | undefined;
  #subscriber: RedisClientType | undefined;
  #subscribed = false;
  #closed = false;
  #pendingBytes = 0;
  #receivedBytes = 0;
  #queue: string[] = [];
  #draining = false;
  #healthy = false;
  readonly channel: string;
  readonly counters = { dropped: 0, ambiguousPublishes: 0, invalid: 0 };

  constructor(
    readonly options: RedisEventsOptions,
    readonly limits: EventLimits,
    readonly receive: (event: LiveEnvelope) => Promise<void>,
    readonly availability: (ready: boolean) => void,
  ) {
    opaqueId.parse(options.channelScope);
    this.channel = `integration:${options.channelScope}:live:v1`;
    eventBudgets(limits);
    if (!Number.isSafeInteger(options.commandTimeoutMs) || options.commandTimeoutMs < 1)
      throw new TypeError("Invalid Redis command timeout");
    for (const value of [options.publishUrl, options.subscribeUrl]) {
      const url = new URL(value);
      if (
        url.protocol !== "rediss:" &&
        !(url.protocol === "redis:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      )
        throw new TypeError("Redis requires verified TLS outside loopback");
    }
  }
  get ready(): boolean {
    return this.#healthy;
  }
  #state(): void {
    const ready =
      !this.#closed &&
      this.#subscribed &&
      !!this.#subscriber?.isReady &&
      !!this.#publisher?.isReady;
    if (ready !== this.#healthy) {
      this.#healthy = ready;
      this.availability(ready);
    }
    if (!ready) {
      this.#queue = [];
      this.#receivedBytes = 0;
    }
  }
  async start(): Promise<void> {
    // Disabled extension never calls this function or imports/constructs a Redis client.
    const { createClient } = await import("redis");
    const make = (url: string) =>
      createClient({
        url,
        disableOfflineQueue: true,
        commandsQueueMaxLength: 16,
        socket: {
          connectTimeout: this.options.commandTimeoutMs,
          reconnectStrategy: (retries) =>
            Math.min(2000, 100 * 2 ** Math.min(retries, 4)) + Math.floor(Math.random() * 100),
        },
      });
    this.#publisher = make(this.options.publishUrl) as RedisClientType;
    this.#subscriber = make(this.options.subscribeUrl) as RedisClientType;
    for (const client of [this.#publisher, this.#subscriber]) {
      client.on("error", () => {
        this.#healthy = false;
        this.availability(false);
        this.#queue = [];
        this.#receivedBytes = 0;
      });
      client.on("reconnecting", () => this.#state());
      client.on("ready", () => this.#state());
      client.on("end", () => this.#state());
    }
    // Reconnect is future-only; node-redis awaits exact-channel resubscription before ready.
    const subscriber = this.#subscriber;
    void subscriber
      .connect()
      .then(async () => {
        if (this.#closed) return;
        await subscriber.subscribe(this.channel, (raw) => this.#receive(raw));
        this.#subscribed = true;
        this.#state();
      })
      .catch(() => this.#state());
    void this.#publisher.connect().catch(() => this.#state());
  }
  #receive(raw: string): void {
    const bytes = Buffer.byteLength(raw);
    if (
      bytes > eventBudgets(this.limits).envelopeBytes ||
      this.#receivedBytes + bytes > this.limits.subscriberBytes
    ) {
      this.counters.dropped++;
      this.#queue = [];
      this.#receivedBytes = 0;
      this.availability(false); // A loss boundary closes/clears all page-local queues, never replays them.
      return;
    }
    this.#receivedBytes += bytes;
    this.#queue.push(raw);
    if (!this.#draining) void this.#drain();
  }
  async #drain(): Promise<void> {
    this.#draining = true;
    try {
      while (!this.#closed && this.#queue.length) {
        const raw = this.#queue.shift()!;
        try {
          await this.receive(decodeEnvelope(raw, this.limits));
        } catch {
          this.counters.invalid++;
        } finally {
          this.#receivedBytes = Math.max(0, this.#receivedBytes - Buffer.byteLength(raw));
        }
      }
    } finally {
      this.#draining = false;
    }
  }
  async publish(event: LiveEnvelope): Promise<void> {
    const raw = JSON.stringify(event);
    decodeEnvelope(raw, this.limits);
    const bytes = Buffer.byteLength(raw);
    if (!this.ready || !this.#publisher || this.#pendingBytes + bytes > this.limits.publisherBytes)
      throw new Error("Event forwarding unavailable");
    this.#pendingBytes += bytes;
    try {
      // No offline queue or retry: loss of the response can mean the event was already published.
      await this.#publisher
        .withCommandOptions({ abortSignal: AbortSignal.timeout(this.options.commandTimeoutMs) })
        .publish(this.channel, raw);
    } catch (error) {
      this.counters.ambiguousPublishes++;
      throw error;
    } finally {
      this.#pendingBytes -= bytes;
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const client of [this.#publisher, this.#subscriber]) if (client?.isOpen) client.destroy();
    this.#state();
  }
}
