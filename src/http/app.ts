import { createServer, METHODS } from "node:http";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { ServiceError } from "../platform/errors.ts";
import { UNLIMITED_HEADER_BYTES } from "../platform/outbound.ts";
import {
  corsHeaders,
  exposeHeader,
  isApiPath,
  isCredentialedRoute,
  isPreflight,
  preflightHeaders,
} from "./cors.ts";
import { adminRoutes } from "./routes/admin.ts";
import { connectionRoutes } from "./routes/connections.ts";
import { consoleRoutes } from "./routes/console.ts";
import { discoveryRoutes } from "./routes/discovery.ts";
import { eventRoutes } from "./routes/events.ts";
import { healthRoutes } from "./routes/health.ts";
import { identityRoutes } from "./routes/identity.ts";
import { jobRoutes } from "./routes/jobs.ts";
import { nativeRoutes } from "./routes/native.ts";
import type { Services } from "./services.ts";

/** Room for JSON framing around the largest Job input or result the service accepts. */
const JSON_OVERHEAD = 64 * 1024;

function pathOf(url: string | undefined): string {
  const raw = url ?? "/";
  const end = raw.indexOf("?");
  return end < 0 ? raw : raw.slice(0, end);
}

/** Routes whose service errors carry `Tableau-Service-Error: 1`, so the SDK can tell them from a provider's. */
function marksServiceErrors(path: string): boolean {
  return path.startsWith("/v1/native/") || path.startsWith("/v1/capabilities/");
}

/** The API role's HTTP server: every route group, CORS for API routes, and one error shape. */
export async function createApi(services: Services): Promise<FastifyInstance> {
  const limits = services.jobs.limits;
  const app = Fastify({
    serverFactory: (handler) =>
      createServer({ requestTimeout: 0, maxHeaderSize: UNLIMITED_HEADER_BYTES }, handler),
    bodyLimit: Math.max(limits.inputBytes, limits.resultBytes) + JSON_OVERHEAD,
    routerOptions: { maxParamLength: 2000 },
    logger: false,
    trustProxy: false,
    requestIdHeader: false,
    exposeHeadRoutes: false,
    forceCloseConnections: "idle",
  });

  // Native routing forwards any method a provider might accept.
  for (const method of METHODS)
    if (!app.supportedMethods.includes(method)) app.addHttpMethod(method, { hasBody: true });

  // Service pages post ordinary HTML forms.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );

  // Open event streams would keep the server from closing, so they end first.
  app.addHook("preClose", async () => {
    services.events?.closeStreams();
  });

  app.addHook("onRequest", async (request, reply) => {
    const path = pathOf(request.raw.url);
    if (!isApiPath(path) || !isPreflight(request.raw)) return;
    const credentialed = isCredentialedRoute("OPTIONS", path);
    reply.hijack();
    reply.raw.writeHead(204, {
      ...preflightHeaders(request.raw, credentialed),
      "cache-control": "no-store",
    });
    reply.raw.end();
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    const path = pathOf(request.raw.url);
    if (isApiPath(path)) {
      for (const [name, value] of Object.entries(
        corsHeaders(request.raw, isCredentialedRoute(request.method, path)),
      ))
        reply.header(name, value);
      const exposed = exposeHeader(Object.keys(reply.getHeaders()));
      if (exposed) reply.header("access-control-expose-headers", exposed);
    }
    return payload;
  });

  app.setErrorHandler((error: FastifyError | ServiceError, request, reply) => {
    const path = pathOf(request.raw.url);
    if (marksServiceErrors(path)) reply.header("tableau-service-error", "1");
    if (error instanceof ServiceError) return reply.status(error.status).send(error.toBody());
    const fastifyCode = (error as FastifyError).code;
    const status = (error as FastifyError).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      const code =
        status === 413
          ? "request-too-large"
          : status === 415
            ? "unsupported-media-type"
            : "invalid-request";
      return reply
        .status(status)
        .send(new ServiceError(status, code, "The request could not be read").toBody());
    }
    services.log.error("request failed", {
      method: request.method,
      path,
      code: fastifyCode,
      error,
    });
    return reply
      .status(500)
      .send(
        new ServiceError(
          500,
          "internal-error",
          "The service could not complete the request",
        ).toBody(),
      );
  });

  app.setNotFoundHandler((request, reply) => {
    if (marksServiceErrors(pathOf(request.raw.url))) reply.header("tableau-service-error", "1");
    return reply.status(404).send(new ServiceError(404, "not-found", "No such route").toBody());
  });

  consoleRoutes(app, services);
  identityRoutes(app, services);
  connectionRoutes(app, services);
  nativeRoutes(app, services);
  jobRoutes(app, services);
  eventRoutes(app, services);
  adminRoutes(app, services);
  healthRoutes(app, services);
  await discoveryRoutes(app, services);
  for (const { mounted } of services.services ?? []) {
    if (mounted) app.register(async (scope) => mounted.routes(scope));
  }
  return app;
}
