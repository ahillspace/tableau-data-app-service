import type { ServerResponse } from "node:http";
import type { AccessContext, CoreServices } from "../core-ports.js";
import type { PublicLiveData } from "../public/schemas.js";
import { type EventLimits, frame, freshEnvelope, type LiveEnvelope } from "./protocol.js";
import type { Sources } from "./sources.js";

export type EventFilter = { sourceId?: string; connectionId?: string; jobId?: string };
export type JobDisclosure = (
  access: AccessContext,
  jobId: string,
) => Promise<{ id: string } | null>;
type Pending = { event: LiveEnvelope; bytes: number };
type Stream = {
  token: string;
  appId: string;
  response: ServerResponse;
  filter: EventFilter;
  queue: Pending[];
  bytes: number;
  pumping: boolean;
  closed: boolean;
};
export class EventStreams {
  #streams = new Set<Stream>();
  #bytes = 0;
  #generation = 0;
  #timer: ReturnType<typeof setInterval>;
  readonly counters = { expired: 0, denied: 0, slow: 0, lost: 0 };
  constructor(
    readonly core: CoreServices,
    readonly sources: Sources,
    readonly limits: EventLimits,
    readonly discloseJob?: JobDisclosure,
  ) {
    this.#timer = setInterval(() => {
      void this.#heartbeat();
    }, limits.heartbeatMs);
    this.#timer.unref();
  }
  async attach(
    token: string,
    appId: string,
    response: ServerResponse,
    filter: EventFilter = {},
  ): Promise<void> {
    await this.core.access.authenticate(token, appId);
    const stream: Stream = {
      token,
      appId,
      response,
      filter,
      queue: [],
      bytes: 0,
      pumping: false,
      closed: false,
    };
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Integration-Origin": "service",
      "X-Accel-Buffering": "no",
    });
    this.#streams.add(stream);
    response.on("close", () => this.#close(stream));
    response.on("error", () => this.#close(stream));
    if (!response.write(frame({ version: 1, kind: "resync-required", reason: "connected" })))
      this.#close(stream);
  }
  async #authorize(stream: Stream, event: LiveEnvelope): Promise<PublicLiveData | undefined> {
    if (stream.closed || !freshEnvelope(event, this.limits)) {
      this.counters.expired++;
      return;
    }
    const access = await this.core.access.authenticate(stream.token, stream.appId);
    if (event.kind === "job-hint") {
      if (
        stream.filter.sourceId ||
        stream.filter.connectionId ||
        (stream.filter.jobId && stream.filter.jobId !== event.jobId)
      )
        return;
      const job = await this.discloseJob?.(access, event.jobId);
      if (!job || !freshEnvelope(event, this.limits)) return;
      return {
        version: 1,
        kind: "job-hint",
        id: event.eventId,
        jobId: job.id,
        revision: event.jobRevision,
      };
    }
    if (
      stream.filter.jobId ||
      (stream.filter.sourceId && stream.filter.sourceId !== event.sourceId)
    )
      return;
    const source = await this.sources.eligible(event.sourceId, event.sourceRevision);
    if (
      !source ||
      (stream.filter.connectionId && stream.filter.connectionId !== source.connection_id) ||
      !(await this.sources.visible(source, access))
    )
      return;
    const now = new Date();
    if (
      !freshEnvelope(event, this.limits, now.getTime()) ||
      !this.sources.provider(source.provider_registration_id).eventValid(
        source,
        {
          ingressAt: new Date(event.ingressAt),
          validUntil: new Date(event.validUntil),
        },
        now,
      )
    )
      return;
    return {
      version: 1,
      kind: "provider",
      id: event.eventId,
      provider: source.provider_registration_id,
      ...(source.connection_id ? { connectionId: source.connection_id } : {}),
      type: event.type,
      payloadEncoding: "base64url",
      payloadMediaType: event.payloadMediaType,
      payload: event.payload,
    };
  }
  async enqueue(event: LiveEnvelope): Promise<void> {
    const generation = this.#generation;
    if (!freshEnvelope(event, this.limits)) {
      this.counters.expired++;
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(event)) + 256;
    for (const stream of this.#streams) {
      try {
        if (!(await this.#authorize(stream, event))) {
          this.counters.denied++;
          continue;
        }
        if (generation !== this.#generation || stream.closed) return;
        if (
          stream.bytes + bytes > this.limits.streamBytes ||
          this.#bytes + bytes > this.limits.aggregateBytes
        ) {
          this.counters.slow++;
          this.#close(stream);
          continue;
        }
        stream.queue.push({ event, bytes });
        stream.bytes += bytes;
        this.#bytes += bytes;
        if (!stream.pumping) void this.#pump(stream);
      } catch {
        this.counters.denied++;
        this.#close(stream);
      }
    }
  }
  async #pump(stream: Stream): Promise<void> {
    stream.pumping = true;
    try {
      while (!stream.closed && stream.queue.length) {
        const pending = stream.queue[0]!;
        // Every queued delivery rereads the bearer/session, source revision, audience and event validity.
        const data = await this.#authorize(stream, pending.event);
        if (data && !stream.closed) await this.#write(stream, frame(data));
        if (stream.closed) break;
        stream.queue.shift();
        stream.bytes -= pending.bytes;
        this.#bytes -= pending.bytes;
      }
    } catch {
      this.#close(stream);
    } finally {
      stream.pumping = false;
    }
  }
  #write(stream: Stream, data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const response = stream.response;
      const timer = setTimeout(() => {
        this.counters.slow++;
        this.#close(stream);
        reject(new Error("SSE client stalled"));
      }, this.limits.stallMs);
      timer.unref();
      const onClose = () => {
        clearTimeout(timer);
        reject(new Error("SSE client disconnected"));
      };
      response.once("close", onClose);
      response.write(data, (error) => {
        clearTimeout(timer);
        response.off("close", onClose);
        error ? reject(error) : resolve();
      });
    });
  }
  #close(stream: Stream): void {
    if (stream.closed) return;
    stream.closed = true;
    this.#streams.delete(stream);
    this.#bytes -= stream.bytes;
    stream.queue = [];
    stream.bytes = 0;
    stream.token = "";
    stream.response.destroy();
  }
  async #heartbeat(): Promise<void> {
    for (const stream of this.#streams) {
      if (stream.pumping) continue;
      stream.pumping = true;
      try {
        await this.core.access.authenticate(stream.token, stream.appId);
        if (!stream.closed) await this.#write(stream, ": heartbeat\n\n");
      } catch {
        this.#close(stream);
      } finally {
        stream.pumping = false;
        if (stream.queue.length && !stream.closed) void this.#pump(stream);
      }
    }
  }
  loss(): void {
    this.#generation++;
    this.counters.lost++;
    for (const stream of this.#streams) {
      if (!stream.pumping)
        stream.response.write(
          frame({ version: 1, kind: "resync-required", reason: "possible-loss" }),
        );
      this.#close(stream);
    }
  }
  close(): void {
    clearInterval(this.#timer);
    for (const stream of this.#streams) this.#close(stream);
  }
}
