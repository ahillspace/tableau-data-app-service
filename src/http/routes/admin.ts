import type { FastifyInstance, FastifyRequest } from "fastify";
import { templates } from "../../catalog/index.ts";
import {
  addOperator,
  addSite,
  listOperators,
  listSites,
  removeOperator,
  removeSite,
  setSiteEnabled,
} from "../../identity/directory.ts";
import { actorOf, parseIdentityKey } from "../../identity/types.ts";
import { listAudit } from "../../persistence/audit.ts";
import { invalid, ServiceError } from "../../platform/errors.ts";
import { csrfTokenFor, operator } from "../auth.ts";
import { clearCookie, OPERATOR_COOKIE, readCookie } from "../cookies.ts";
import { limitQuery, objectBody, param, query } from "../request.ts";
import type { Services } from "../services.ts";

function text(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || value === "")
    throw invalid([{ path: name, rule: "required:string" }]);
  return value;
}

/** A record ID from the body, or from `?id=` for clients that send DELETE without a body. */
function recordId(request: FastifyRequest): string {
  const fromQuery = query(request, "id");
  return fromQuery ?? text(objectBody(request), "id");
}

/** The operator API. Every route needs an operator bearer; app and restored bearers are refused. */
export function adminRoutes(app: FastifyInstance, services: Services): void {
  const { db, identity, connections, jobs } = services;
  const definitions = connections.definitions;
  const op = (request: FastifyRequest) =>
    operator(identity, request, {
      publicOrigin: services.publicOrigin,
      consoleEnabled: services.consoleEnabled ?? false,
    });
  app.addHook("onRequest", async (request) => {
    const path = request.url.split("?")[0] ?? "";
    if (
      (request.method === "POST" || request.method === "PATCH" || request.method === "PUT") &&
      /^\/v1\/admin\/definitions(?:\/|$)/.test(path) &&
      request.url.includes("?")
    )
      throw invalid([{ path: "query", rule: "not-allowed" }]);
  });

  app.get("/v1/admin/status", async (request) => {
    await op(request);
    if (!services.operations)
      throw new ServiceError(503, "status-unavailable", "Operational observations are unavailable");
    return services.operations.status();
  });
  app.get("/v1/admin/metrics", async (request) => {
    await op(request);
    if (!services.metrics)
      throw new ServiceError(503, "metrics-unavailable", "Operational metrics are unavailable");
    const from = query(request, "from"),
      to = query(request, "to"),
      definition = query(request, "definition");
    return services.metrics.view({
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(definition !== undefined ? { definition } : {}),
    });
  });
  app.get("/v1/admin/session", async (request) => {
    const principal = await op(request);
    const cookie = readCookie(request, OPERATOR_COOKIE);
    return {
      operator: { displayName: principal.userName },
      expiresAt: principal.expiresAt.toISOString(),
      csrfToken: cookie ? csrfTokenFor(cookie) : "",
    };
  });
  app.post("/v1/admin/session/logout", async (request, reply) => {
    const principal = await op(request);
    await identity.endSession(principal.sessionId);
    clearCookie(reply, OPERATOR_COOKIE, { sameSite: "Strict" });
    return { signedOut: true };
  });
  app.get("/v1/admin/catalog", async (request) => {
    await op(request);
    return { templates };
  });
  app.get("/v1/admin/definitions", async (request) => {
    await op(request);
    return { definitions: await definitions.listForOperators() };
  });
  app.get("/v1/admin/definitions/:id", async (request) => {
    await op(request);
    return { definition: await definitions.viewForOperators(param(request, "id")) };
  });
  app.post("/v1/admin/definitions", async (request, reply) => {
    const principal = await op(request);
    return reply.status(201).send({
      definition: await connections.afterDefinitionMutation(
        await definitions.create(actorOf(principal), request.body),
      ),
    });
  });
  app.patch("/v1/admin/definitions/:id", async (request) => {
    const principal = await op(request);
    return {
      definition: await connections.afterDefinitionMutation(
        await definitions.patch(actorOf(principal), param(request, "id"), request.body),
      ),
    };
  });
  app.put("/v1/admin/definitions/:id", async (request) => {
    const principal = await op(request);
    const { view, generation, connectionsEnded } = await definitions.redefine(
      actorOf(principal),
      param(request, "id"),
      request.body,
    );
    return { definition: view, generation, connectionsEnded };
  });
  app.post("/v1/admin/definitions/:id/retire", async (request) => {
    const principal = await op(request);
    const { view, connectionsEnded } = await definitions.retire(
      actorOf(principal),
      param(request, "id"),
      request.body,
    );
    return { definition: view, connectionsEnded };
  });
  app.put("/v1/admin/definitions/:id/secrets", async (request) => {
    const principal = await op(request);
    return {
      definition: await connections.afterDefinitionMutation(
        await definitions.setSecrets(actorOf(principal), param(request, "id"), request.body),
      ),
    };
  });
  app.post("/v1/admin/definitions/:id/connect", async (request, reply) => {
    const principal = await op(request);
    return reply
      .status(201)
      .send(await connections.startConnect(principal, param(request, "id"), "shared"));
  });

  app.get("/v1/admin/connections", async (request) => {
    await op(request);
    return {
      connections: await connections.listConnections({
        definitionId: query(request, "definition") ?? query(request, "definitionId"),
        status: query(request, "status"),
        limit: limitQuery(request),
      }),
    };
  });
  app.delete("/v1/admin/connections/:connectionId", async (request) => {
    const principal = await op(request);
    return {
      disconnected: await connections.disconnectAny(principal, param(request, "connectionId")),
    };
  });

  app.get("/v1/admin/sites", async (request) => {
    await op(request);
    return { sites: await listSites(db) };
  });
  app.post("/v1/admin/sites", async (request, reply) => {
    const principal = await op(request);
    const body = objectBody(request);
    // The directory validates these fields; the Default site's content URL is the empty string.
    const site = await addSite(db, actorOf(principal), {
      deploymentId: body.deploymentId as string,
      contentUrl: body.contentUrl as string,
    });
    return reply.status(201).send({ site });
  });
  app.patch("/v1/admin/sites", async (request) => {
    const principal = await op(request);
    const body = objectBody(request);
    if (typeof body.enabled !== "boolean")
      throw invalid([{ path: "enabled", rule: "required:boolean" }]);
    return { site: await setSiteEnabled(db, actorOf(principal), text(body, "id"), body.enabled) };
  });
  app.delete("/v1/admin/sites", async (request) => {
    const principal = await op(request);
    await removeSite(db, actorOf(principal), recordId(request));
    return { removed: true };
  });

  app.get("/v1/admin/operators", async (request) => {
    await op(request);
    return { operators: await listOperators(db) };
  });
  app.post("/v1/admin/operators", async (request, reply) => {
    const principal = await op(request);
    const body = objectBody(request);
    const added = await addOperator(db, actorOf(principal), {
      deploymentId: body.deploymentId as string,
      siteContentUrl: body.siteContentUrl as string,
      username: body.username as string,
    });
    return reply.status(201).send({ operator: added });
  });
  app.delete("/v1/admin/operators", async (request) => {
    const principal = await op(request);
    await removeOperator(db, actorOf(principal), recordId(request));
    return { removed: true };
  });

  app.get("/v1/admin/apps", async (request) => {
    await op(request);
    return { apps: await identity.listApps() };
  });
  app.post("/v1/admin/identities/:key/revoke-sessions", async (request) => {
    const principal = await op(request);
    const target = parseIdentityKey(param(request, "key"));
    if (!target) throw invalid([{ path: "key", rule: "identity-key" }]);
    return { sessionsEnded: await identity.revokeSessions(actorOf(principal), target) };
  });

  app.get("/v1/admin/jobs", async (request) => {
    await op(request);
    return {
      jobs: await jobs.list({
        state: query(request, "state"),
        handler: query(request, "handler"),
        limit: limitQuery(request),
      }),
    };
  });
  app.post("/v1/admin/jobs/:id/cancel", async (request) => {
    const principal = await op(request);
    return { job: await jobs.cancelAny(principal, param(request, "id")) };
  });

  app.get("/v1/admin/audit", async (request) => {
    await op(request);
    return {
      entries: await listAudit(db, {
        limit: limitQuery(request),
        before: query(request, "before"),
        action: query(request, "action"),
        definition: query(request, "definition"),
      }),
    };
  });
}
