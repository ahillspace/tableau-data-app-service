import type { FastifyInstance } from "fastify";
import { ServiceError } from "../../platform/errors.ts";
import { caller } from "../auth.ts";
import { corsHeaders } from "../cors.ts";
import { param, queryList } from "../request.ts";
import type { Services } from "../services.ts";

function eventsOff(): ServiceError {
  return new ServiceError(404, "events-off", "Events are not turned on for this service");
}

export function eventRoutes(app: FastifyInstance, services: Services): void {
  app.get("/v1/events/stream", async (request, reply) => {
    const events = services.events;
    if (!events) throw eventsOff();
    const principal = await caller(services.identity, request);
    const res = reply.raw;
    const definitions = queryList(request, "definitions");
    let drainListener: (() => void) | undefined;
    let ended = false;
    // Validate before the response starts so a refusal is an ordinary JSON error.
    const pending: string[] = [];
    let live = false;
    const sink = {
      write(chunk: string): boolean {
        if (ended) return true;
        if (!live) {
          pending.push(chunk);
          return true;
        }
        return res.write(chunk);
      },
      onDrain(listener: () => void) {
        drainListener = listener;
      },
      end() {
        if (ended) return;
        ended = true;
        if (live) res.end();
      },
    };
    const stream = await events.open(principal, definitions, sink);
    reply.hijack();
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-accel-buffering": "no",
      ...corsHeaders(request.raw, false),
      "access-control-expose-headers": "content-type",
    });
    live = true;
    res.on("drain", () => drainListener?.());
    res.once("close", () => stream.close());
    res.write(": open\n\n");
    for (const chunk of pending.splice(0)) res.write(chunk);
    if (ended) res.end();
  });

  // Provider deliveries. The body is read raw because signatures cover the exact bytes.
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: Number.MAX_SAFE_INTEGER },
      (_request, body, done) => done(null, body),
    );
    scope.post("/v1/events/ingest/:definitionId", async (request, reply) => {
      const events = services.events;
      if (!events) throw eventsOff();
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const outcome = await events.ingest(param(request, "definitionId"), {
        headers: request.headers,
        body,
      });
      // Acknowledge first; publishing happens once the provider has its answer.
      reply.raw.once("finish", () => void outcome.publish());
      reply.status(outcome.response.status);
      if (outcome.response.contentType) reply.header("content-type", outcome.response.contentType);
      return reply.send(outcome.response.body ?? "");
    });
  });
}
