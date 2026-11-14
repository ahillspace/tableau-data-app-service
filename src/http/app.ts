import { createServer } from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { ApiExtension, CoreServices } from "../core-ports.js";
import { assertSchema, type Database } from "../db/database.js";
import { HEADER_PROFILE } from "../public/headers.js";
import { ServiceError } from "./errors.js";

export async function createHttpApp(options: {
  db: Database;
  core?: CoreServices;
  extensions?: readonly ApiExtension[];
}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: false,
    requestIdHeader: false,
    exposeHeadRoutes: false,
    routerOptions: { maxParamLength: 200 },
    bodyLimit: 1024 * 1024,
    forceCloseConnections: "idle",
    serverFactory: (handler) =>
      createServer({ maxHeaderSize: HEADER_PROFILE.physicalBytes, requestTimeout: 0 }, handler),
  });
  app.addHook("onSend", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
  });
  app.setErrorHandler((error, request, reply) => {
    const known = error instanceof ServiceError;
    const validation = error instanceof ZodError;
    reply
      .status(known ? error.status : validation ? 400 : 500)
      .header("X-Integration-Origin", "service")
      .header("X-Integration-Error", "1")
      .send({
        error: {
          code: known ? error.code : validation ? "invalid-input" : "internal-error",
          message: known ? error.message : validation ? "Invalid request input" : "Request failed",
        },
        requestId: request.id,
      });
  });
  app.get("/health/live", async () => ({ status: "live" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      await assertSchema(options.db);
      const events = await Promise.all(
        (options.extensions ?? [])
          .filter((extension) => extension.health)
          .map((extension) => extension.health?.().catch(() => "degraded")),
      );
      return { core: "ready", events: events.length ? events : "disabled" };
    } catch {
      reply.status(503);
      return { core: "unavailable" };
    }
  });
  for (const extension of options.extensions ?? []) {
    if (!options.core) throw new Error("API extensions require configured core services");
    await extension.register(app, options.core);
  }
  app.addHook("onClose", async () => {
    for (const extension of options.extensions ?? []) await extension.close?.();
  });
  return app;
}
