import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ServiceError } from "../../platform/errors.ts";
import { caller } from "../auth.ts";
import { corsHeaders, exposeHeader } from "../cors.ts";
import { objectBody, param } from "../request.ts";
import type { Services } from "../services.ts";

const PREFIX = "/v1/native/";

function rawHeaderPairs(request: IncomingMessage): [string, string][] {
  const pairs: [string, string][] = [];
  const raw = request.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([raw[i] as string, raw[i + 1] as string]);
  return pairs;
}

/** The request target after `/v1/native/{definitionId}`, exactly as the app sent it. */
function nativeTarget(url: string): { definitionId: string; target: string } {
  const rest = url.slice(PREFIX.length);
  const end = rest.search(/[/?]/);
  const encoded = end < 0 ? rest : rest.slice(0, end);
  let definitionId: string;
  try {
    definitionId = decodeURIComponent(encoded);
  } catch {
    definitionId = encoded;
  }
  return { definitionId, target: end < 0 ? "" : rest.slice(end) };
}

function hasBody(request: IncomingMessage): boolean {
  const length = request.headers["content-length"];
  return (
    request.headers["transfer-encoding"] !== undefined || (length !== undefined && length !== "0")
  );
}

/**
 * Native routing. Bodies are never parsed: the raw request stream goes upstream and the provider's
 * response stream comes back, both with backpressure. A client abort aborts the upstream request.
 */
export function nativeRoutes(app: FastifyInstance, services: Services): void {
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_request, _payload, done) => done(null, undefined));
    // Native traffic has no content-type rule. Fastify refuses a malformed content type before any
    // parser runs, so the parsed copy is replaced with a neutral one; the router forwards rawHeaders,
    // which keep the app's value as sent.
    scope.addHook("onRequest", async (request) => {
      if (request.raw.headers["content-type"] !== undefined)
        request.raw.headers["content-type"] = "application/octet-stream";
    });

    const forward = async (request: FastifyRequest, reply: FastifyReply) => {
      const raw = request.raw;
      const { definitionId, target } = nativeTarget(raw.url ?? "");
      const controller = new AbortController();
      const abort = () =>
        controller.abort(new ServiceError(499, "client-closed", "The client closed the request"));
      const res = reply.raw;
      res.once("close", () => {
        if (!res.writableFinished) abort();
      });
      const principal = await caller(services.identity, request);
      const upstream = await services.router.forward({
        principal,
        definitionId,
        method: raw.method ?? "GET",
        target,
        headers: rawHeaderPairs(raw),
        body: hasBody(raw) ? raw : null,
        signal: controller.signal,
      });
      reply.hijack();
      await sendNative(raw, res, upstream.status, upstream.headers, upstream.body, abort, services);
    };

    scope.route({
      method: scope.supportedMethods,
      url: "/v1/native/:definitionId",
      handler: forward,
    });
    scope.route({
      method: scope.supportedMethods,
      url: "/v1/native/:definitionId/*",
      handler: forward,
    });
  });

  app.post("/v1/capabilities/:definitionId/:name", async (request, reply) => {
    const controller = new AbortController();
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished)
        controller.abort(new ServiceError(499, "client-closed", "The client closed the request"));
    });
    const principal = await caller(services.identity, request);
    const result = await services.router.capability(
      principal,
      param(request, "definitionId"),
      param(request, "name"),
      objectBody(request).input,
      controller.signal,
    );
    return { result: result ?? null };
  });
}

async function sendNative(
  request: IncomingMessage,
  res: ServerResponse,
  status: number,
  headers: [string, string][],
  body: NodeJS.ReadableStream & { destroy(error?: Error): void },
  abort: () => void,
  services: Services,
): Promise<void> {
  const cors = corsHeaders(request, false);
  const expose = exposeHeader(headers.map(([name]) => name));
  const flat: string[] = [];
  for (const [name, value] of headers) flat.push(name, value);
  for (const [name, value] of Object.entries(cors)) flat.push(name, value);
  if (expose) flat.push("access-control-expose-headers", expose);
  try {
    res.writeHead(status, flat);
  } catch (error) {
    body.destroy();
    services.log.warn("native response headers not sendable", { status, error });
    if (!res.headersSent) {
      res.writeHead(502, {
        "content-type": "application/json",
        "tableau-service-error": "1",
        ...cors,
      });
      res.end(
        JSON.stringify(
          new ServiceError(
            502,
            "upstream-interrupted",
            "The provider's response could not be relayed",
            { upstream: "may-have-been-sent" },
          ).toBody(),
        ),
      );
    } else res.destroy();
    return;
  }
  if (request.method === "HEAD" || status === 204 || status === 304) {
    body.destroy();
    res.end();
    return;
  }
  try {
    await pipeline(body, res);
  } catch (error) {
    // The upstream ended mid-body or the client left; either way the client response ends with an error.
    abort();
    if (!res.destroyed) res.destroy(error as Error);
  }
}
