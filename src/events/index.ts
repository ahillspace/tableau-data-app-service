import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ApiExtension, CoreServices } from "../core-ports.js";
import { ServiceError } from "../http/errors.js";
import { opaqueId } from "../public/schemas.js";
import { type EventLimits, eventBudgets, freshEnvelope, type LiveEnvelope } from "./protocol.js";
import { RedisEvents, type RedisEventsOptions } from "./redis.js";
import { Sources } from "./sources.js";
import { EventStreams, type JobDisclosure } from "./streams.js";
import type { EventProvider, IngressReply } from "./types.js";

export type EventsOptions =
  | { enabled: false }
  | {
      enabled: true;
      redis: RedisEventsOptions;
      limits: EventLimits;
      providers: ReadonlyMap<string, EventProvider>;
      discloseJob?: JobDisclosure;
    };
export class EventsExtension implements ApiExtension {
  sources: Sources | undefined;
  #broker: RedisEvents | undefined;
  #streams: EventStreams | undefined;
  constructor(readonly options: EventsOptions) {}
  diagnostics() {
    return {
      transport: this.#broker ? { ...this.#broker.counters } : null,
      streams: this.#streams ? { ...this.#streams.counters } : null,
    };
  }
  async health(): Promise<"ready" | "degraded" | "disabled"> {
    return !this.options.enabled ? "disabled" : this.#broker?.ready ? "ready" : "degraded";
  }
  async register(app: FastifyInstance, core: CoreServices): Promise<void> {
    if (!this.options.enabled) {
      app.get("/v1/apps/:app/events", async () => {
        throw new ServiceError(503, "events-disabled", "Live events are disabled");
      });
      return;
    }
    const options = this.options;
    eventBudgets(options.limits);
    const sources = (this.sources = new Sources(core, options.providers));
    const streams = (this.#streams = new EventStreams(
      core,
      sources,
      options.limits,
      options.discloseJob,
    ));
    const broker = (this.#broker = new RedisEvents(
      options.redis,
      options.limits,
      async (event) => {
        if (broker.ready) await streams.enqueue(event);
      },
      (ready) => {
        if (!ready) streams.loss();
      },
    ));
    await broker.start();
    app.get<{
      Params: { app: string };
      Querystring: { sourceId?: string; connectionId?: string; jobId?: string };
    }>("/v1/apps/:app/events", async (request, reply) => {
      if (!broker.ready)
        throw new ServiceError(503, "events-unavailable", "Live events are unavailable");
      opaqueId.parse(request.params.app);
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith("Bearer ") || authorization.includes(","))
        throw new ServiceError(401, "authentication-required", "Sign in to continue");
      const filter: { sourceId?: string; connectionId?: string; jobId?: string } = {};
      for (const key of ["sourceId", "connectionId", "jobId"] as const)
        if (request.query[key] !== undefined) filter[key] = opaqueId.parse(request.query[key]);
      await core.access.authenticate(authorization.slice(7), request.params.app);
      // Preserve core CORS/Vary headers before handing network writes to the bounded SSE owner.
      for (const [key, value] of Object.entries(reply.getHeaders()))
        if (value !== undefined) reply.raw.setHeader(key, value);
      await streams.attach(authorization.slice(7), request.params.app, reply.raw, filter);
      reply.hijack();
      if (!broker.ready) streams.loss();
    });
    // Raw parsers are confined to the provider ingress scope, preserving every signature byte.
    await app.register(async (ingress) => {
      ingress.removeAllContentTypeParsers();
      ingress.addContentTypeParser(
        "*",
        { parseAs: "buffer", bodyLimit: options.limits.payloadBytes + 16384 },
        (_request, body, done) => done(null, body),
      );
      ingress.post<{ Params: { registration: string; source: string }; Body: Buffer }>(
        "/v1/providers/:registration/events/:source",
        {
          bodyLimit: options.limits.payloadBytes + 16384,
        },
        async (request, reply) => {
          const provider = sources.provider(opaqueId.parse(request.params.registration));
          const source = await sources.eligible(opaqueId.parse(request.params.source));
          if (!source || source.provider_registration_id !== request.params.registration)
            throw new ServiceError(404, "not-found", "Event source not found");
          const headers = new Headers();
          for (let i = 0; i < request.raw.rawHeaders.length; i += 2)
            headers.append(request.raw.rawHeaders[i]!, request.raw.rawHeaders[i + 1]!);
          const now = new Date();
          const verified = await provider.verify({
            source,
            privateContext: sources.context(source),
            headers,
            raw: request.body,
            now,
          });
          const send = (result: IngressReply) =>
            reply
              .code(result.status)
              .header("Cache-Control", "no-store")
              .type(result.contentType ?? "text/plain")
              .send(result.body ?? "");
          if ("challenge" in verified) return send(verified.challenge);
          const event = verified.event;
          if (event.payload.byteLength > options.limits.payloadBytes)
            throw new ServiceError(
              413,
              "event-too-large",
              "Event exceeds the configured payload limit",
            );
          const envelope: LiveEnvelope = {
            version: 1,
            kind: "provider",
            eventId: opaqueId.parse(event.id),
            sourceId: source.id,
            sourceRevision: source.revision,
            ingressAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + options.limits.maxAgeMs).toISOString(),
            validUntil: event.validUntil.toISOString(),
            type: opaqueId.parse(event.type),
            payloadEncoding: "base64url",
            payloadMediaType: event.mediaType,
            payload: Buffer.from(event.payload).toString("base64url"),
          };
          const current = await sources.eligible(source.id, source.revision);
          if (
            !current ||
            !freshEnvelope(envelope, options.limits) ||
            !provider.eventValid(
              current,
              { ingressAt: now, validUntil: event.validUntil },
              new Date(),
            )
          )
            throw new ServiceError(403, "event-invalid", "Event authority or validity expired");
          try {
            await broker.publish(envelope);
          } catch {
            return send(provider.forwardingUnavailable);
          }
          return send(verified.acknowledgement);
        },
      );
    });
  }
  /** Only postcommit durable notifications; this function never initiates or schedules work. */
  async publishJobHint(jobId: string, revision: number): Promise<boolean> {
    if (!this.options.enabled || !this.#broker?.ready) return false;
    const now = new Date();
    try {
      await this.#broker.publish({
        version: 1,
        kind: "job-hint",
        eventId: randomUUID(),
        jobId: opaqueId.parse(jobId),
        jobRevision: revision,
        ingressAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.options.limits.maxAgeMs).toISOString(),
      });
      return true;
    } catch {
      return false;
    }
  }
  async close(): Promise<void> {
    this.#streams?.close();
    await this.#broker?.close();
  }
}
export function createEventsExtension(options: EventsOptions): EventsExtension {
  return new EventsExtension(options);
}
export { SourceMaintenance, type SourceMaintenanceOptions } from "./lifecycle.js";
export type { EventLimits } from "./protocol.js";
export { Sources } from "./sources.js";
export type { EventProvider, SourceHook, SourcePublication } from "./types.js";
