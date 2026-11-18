import type { ConnectionService } from "../connections/service.ts";
import type { Principal } from "../identity/types.ts";
import type { Clock } from "../platform/clock.ts";
import { invalid, notFound, ServiceError } from "../platform/errors.ts";
import type { Log } from "../platform/log.ts";
import type { EventBus, LossReason, ServiceEvent } from "./types.ts";
import { verifyDelivery } from "./verification.ts";

/** Events a slow client may have queued before the oldest are dropped. */
export const STREAM_BUFFER = 256;
const HEARTBEAT_MS = 25_000;
const RECHECK_MS = 30_000;
const MAX_DEFINITIONS = 50;

/** Where a stream writes: an SSE response, or a test double. */
export type StreamSink = {
  /** Returns false when the sink is full; `drain` fires when it can take more. */
  write(chunk: string): boolean;
  onDrain(listener: () => void): void;
  end(): void;
};

function frame(name: string, data: unknown, id?: string): string {
  return `${id ? `id: ${id}\n` : ""}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

class Stream {
  readonly principal: Principal;
  readonly definitions: ReadonlySet<string>;
  readonly #sink: StreamSink;
  readonly #queue: string[] = [];
  #blocked = false;
  #lost: LossReason | undefined;
  #closed = false;
  readonly #onClose: () => void;

  constructor(
    principal: Principal,
    definitions: Set<string>,
    sink: StreamSink,
    onClose: () => void,
  ) {
    this.principal = principal;
    this.definitions = definitions;
    this.#sink = sink;
    this.#onClose = onClose;
    sink.onDrain(() => {
      this.#blocked = false;
      this.#flush();
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  loss(reason: LossReason): void {
    this.#lost ??= reason;
    this.#flush();
  }

  event(event: ServiceEvent): void {
    if (this.#queue.length >= STREAM_BUFFER) {
      this.#queue.shift();
      this.#lost ??= "slow-client";
    }
    this.#queue.push(frame("event", event, event.id));
    this.#flush();
  }

  heartbeat(): void {
    if (!this.#blocked) this.#write(": keep-alive\n\n");
  }

  #flush(): void {
    while (!this.#blocked && !this.#closed) {
      if (this.#lost) {
        const reason = this.#lost;
        this.#lost = undefined;
        this.#write(frame("possible-loss", { reason }));
        continue;
      }
      const next = this.#queue.shift();
      if (next === undefined) return;
      this.#write(next);
    }
  }

  #write(chunk: string): void {
    if (this.#closed) return;
    if (!this.#sink.write(chunk)) this.#blocked = true;
  }

  close(reason?: string): void {
    if (this.#closed) return;
    if (reason) this.#write(frame("end", { reason }));
    this.#closed = true;
    this.#queue.length = 0;
    this.#sink.end();
    this.#onClose();
  }
}

export type EventsOptions = {
  bus: EventBus;
  connections: ConnectionService;
  clock: Clock;
  log: Log;
  /** Whether a bearer's session is still valid; streams whose session ended are closed. */
  sessionValid(principal: Principal): Promise<boolean>;
};

/**
 * Live events: verifies provider deliveries, publishes them to the bus, and delivers what the bus
 * carries to this replica's streams. An event reaches a stream subscribed to its definition whose
 * identity's site is in the definition's audience, for shared and personal definitions alike.
 */
export class EventService {
  readonly #bus: EventBus;
  readonly #connections: ConnectionService;
  readonly #clock: Clock;
  readonly #log: Log;
  readonly #sessionValid: (principal: Principal) => Promise<boolean>;
  readonly #streams = new Set<Stream>();
  #heartbeat: NodeJS.Timeout | undefined;
  #recheck: NodeJS.Timeout | undefined;
  /** Deliveries run one at a time so streams see events in the order the bus carried them. */
  #delivering: Promise<void> = Promise.resolve();
  #stopping = false;

  constructor(options: EventsOptions) {
    this.#bus = options.bus;
    this.#connections = options.connections;
    this.#clock = options.clock;
    this.#log = options.log;
    this.#sessionValid = options.sessionValid;
  }

  get ready(): boolean {
    return this.#bus.ready;
  }

  get streamCount(): number {
    return this.#streams.size;
  }

  async start(): Promise<void> {
    await this.#bus.start({
      onEvent: (event) => {
        this.#delivering = this.#delivering
          .then(() => this.#deliver(event))
          .catch((error: unknown) =>
            this.#log.warn("event not delivered", { eventId: event.id, error }),
          );
      },
      onLoss: (reason) => {
        for (const stream of this.#streams) stream.loss(reason);
      },
    });
    this.#heartbeat = setInterval(() => {
      for (const stream of this.#streams) stream.heartbeat();
    }, HEARTBEAT_MS);
    this.#heartbeat.unref();
    this.#recheck = setInterval(() => void this.recheck(), RECHECK_MS);
    this.#recheck.unref();
  }

  /**
   * Ends every open stream with `service-stopping` and refuses new ones. The HTTP server calls this
   * before it closes, because it waits for open responses and a stream never ends on its own.
   */
  closeStreams(): void {
    this.#stopping = true;
    for (const stream of [...this.#streams]) stream.close("service-stopping");
  }

  async close(): Promise<void> {
    clearInterval(this.#heartbeat);
    clearInterval(this.#recheck);
    this.closeStreams();
    await this.#bus.close();
  }

  /**
   * Opens a stream for definitions the caller's site may use. The stream starts with `possible-loss`
   * because nothing before it is replayed.
   */
  async open(
    principal: Principal,
    definitionIds: string[],
    sink: StreamSink,
  ): Promise<{ close(): void }> {
    if (principal.kind !== "app")
      throw new ServiceError(
        403,
        "app-session-required",
        "Event streams are opened from a Data App session",
      );
    if (this.#stopping)
      throw new ServiceError(503, "service-stopping", "This replica is shutting down; reconnect");
    const ids = [...new Set(definitionIds.filter(Boolean))];
    if (!ids.length) throw invalid([{ path: "definitions", rule: "required" }]);
    if (ids.length > MAX_DEFINITIONS)
      throw invalid([{ path: "definitions", rule: `max-items:${MAX_DEFINITIONS}` }]);
    const current = await this.#connections.definitions.current();
    for (const id of ids) {
      const definition = current.get(id);
      if (!definition) throw notFound("definition-not-found", `No definition ${id}`);
      if (!definition.enabled || definition.retired)
        throw new ServiceError(403, "definition-disabled", `The definition ${id} is disabled`);
      if (!definition.audience.includes(principal.trustedSiteId))
        throw new ServiceError(403, "not-in-audience", `Your Tableau site cannot use ${id}`);
      if (!definition.webhook)
        throw new ServiceError(
          409,
          "events-not-supported",
          `The definition ${id} has no event source`,
        );
    }
    // Shutdown may have begun while the definitions loaded; the stream is registered only if not.
    if (this.#stopping)
      throw new ServiceError(503, "service-stopping", "This replica is shutting down; reconnect");
    const stream: Stream = new Stream(principal, new Set(ids), sink, () =>
      this.#streams.delete(stream),
    );
    this.#streams.add(stream);
    stream.loss("stream-start");
    if (!this.#bus.ready) stream.loss("fan-out-unavailable");
    return { close: () => stream.close() };
  }

  async #deliver(event: ServiceEvent): Promise<void> {
    const definition = await this.#connections.definitions.get(event.definitionId);
    if (!definition || !definition.enabled || definition.retired) return;
    const now = this.#clock.now().getTime();
    for (const stream of this.#streams) {
      if (!stream.definitions.has(event.definitionId)) continue;
      if (stream.principal.expiresAt.getTime() <= now) {
        stream.close("session-expired");
        continue;
      }
      if (definition.audience.includes(stream.principal.trustedSiteId)) stream.event(event);
    }
  }

  /** Closes streams whose session ended or was revoked. */
  async recheck(): Promise<void> {
    for (const stream of [...this.#streams]) {
      let valid: boolean;
      try {
        valid = await this.#sessionValid(stream.principal);
      } catch {
        continue;
      }
      if (!valid) stream.close("session-ended");
    }
  }

  /**
   * Receives a provider delivery. The provider gets its answer as soon as the delivery is verified;
   * publishing happens after, so a slow or unavailable bus never delays the acknowledgment.
   */
  async ingest(
    definitionId: string,
    delivery: {
      headers: Record<string, string | string[] | undefined>;
      body: Buffer;
      query?: URLSearchParams;
    },
  ): Promise<{
    response: { status: number; contentType?: string; body?: string };
    publish(): Promise<void>;
  }> {
    const { webhook, signingSecret } = await this.#connections.webhookSnapshot(definitionId);
    const now = this.#clock.now();
    const outcome = verifyDelivery(webhook, { ...delivery, now }, signingSecret);
    const events: ServiceEvent[] = outcome.events.map((e) => ({
      id: e.id,
      definitionId,
      type: e.type,
      account: e.account,
      payload: e.payload,
      receivedAt: now.toISOString(),
    }));
    return {
      response: outcome.response,
      publish: async () => {
        for (const event of events) {
          try {
            await this.#bus.publish(event);
          } catch (error) {
            this.#log.warn("event not published", { definitionId, eventId: event.id, error });
          }
        }
      },
    };
  }
}
