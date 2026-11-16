import type { FastifyInstance } from "fastify";
import { databaseTime, schemaIsCurrent } from "../../persistence/database.ts";
import type { Services } from "../services.ts";

/** Readiness: the database answers, the schema is current and, with events on, fan-out is up. */
export function healthRoutes(
  app: FastifyInstance,
  services: Pick<Services, "db" | "events">,
): void {
  app.get("/health/live", async () => ({ status: "live" }));
  app.get("/health/ready", async (_request, reply) => {
    const checks: Record<string, boolean> = {};
    checks.database = await databaseTime(services.db).then(
      () => true,
      () => false,
    );
    checks.schema = checks.database && (await schemaIsCurrent(services.db));
    if (services.events) checks.events = services.events.ready;
    const ready = Object.values(checks).every(Boolean);
    return reply.status(ready ? 200 : 503).send({ status: ready ? "ready" : "not-ready", checks });
  });
}
