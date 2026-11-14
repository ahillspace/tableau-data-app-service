import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { SessionService } from "../access/sessions.js";
import { cookieValue, restorationCookieName } from "../access/sessions.js";
import { opaqueId, sessionBeginSchema } from "../public/schemas.js";
import { verifier } from "../security/secrets.js";
import { absent } from "./errors.js";
import { completionPage, handoffPage } from "./handoff-page.js";
import { requestAbort } from "./wire.js";

function browserHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers))
    if (typeof value === "string") headers.set(name, value);
  return headers;
}
export function registerSessionRoutes(
  app: FastifyInstance,
  sessions: SessionService,
  serviceOrigin: string,
): void {
  app.post("/v1/session/transactions", async (request, reply) => {
    const input = sessionBeginSchema.parse(request.body);
    const result = await sessions.begin(input.appId, input.deploymentId, input.initiationVerifier);
    reply.status(201);
    return { ...result, launchUrl: `${serviceOrigin}/v1/session/transactions/${result.id}/launch` };
  });
  app.get("/v1/session/transactions/:id/launch", async (request, reply) => {
    const { id } = z.strictObject({ id: opaqueId }).parse(request.params);
    const transaction = await sessions.db
      .selectFrom("session_transactions")
      .select("id")
      .where("id", "=", id)
      .executeTakeFirst();
    if (!transaction) absent();
    return handoffPage(reply, id, `/v1/session/transactions/${id}/launch`);
  });
  app.post("/v1/session/transactions/:id/launch", async (request, reply) => {
    const { id } = z.strictObject({ id: opaqueId }).parse(request.params);
    const { initiationProof } = z
      .strictObject({ initiationProof: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .parse(request.body);
    const result = await sessions.launch(id, initiationProof, browserHeaders(request));
    reply.header(
      "set-cookie",
      `__Host-integration-correlation-${id}=${result.browserSecret}; Secure; HttpOnly; SameSite=Lax; Path=/`,
    );
    return { authorizationUrl: result.authorizationUrl };
  });
  const callback = async (
    request: FastifyRequest,
    reply: Parameters<typeof completionPage>[0],
    adapterId?: string,
  ) => {
    const parameters = new URL(request.raw.url ?? "", serviceOrigin).searchParams;
    const state = parameters.get("state");
    if (!state) absent();
    const hint = await sessions.db
      .selectFrom("session_transactions")
      .select(["id", "deployment_id"])
      .where("state_verifier", "=", verifier(state))
      .executeTakeFirst();
    if (!hint) absent();
    const selected = sessions.adapters.get(hint.deployment_id);
    if (!selected || (adapterId && selected.id !== adapterId)) absent();
    const id = await sessions.callback(
      selected.id,
      parameters,
      cookieValue(request.headers.cookie, `__Host-integration-correlation-${hint.id}`),
      requestAbort(request, reply),
    );
    reply.header(
      "set-cookie",
      `__Host-integration-correlation-${id}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    );
    return completionPage(reply, id);
  };
  app.get("/v1/session/callback/:adapter", async (request, reply) =>
    callback(request, reply, z.strictObject({ adapter: opaqueId }).parse(request.params).adapter),
  );
  app.get("/Callback", async (request, reply) =>
    callback(request, reply, "tableau-server-reference"),
  );
  app.post("/v1/session/transactions/:id/redeem", async (request, reply) => {
    const { id } = z.strictObject({ id: opaqueId }).parse(request.params);
    const { initiationProof } = z
      .strictObject({ initiationProof: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .parse(request.body);
    const result = await sessions.redeem(id, initiationProof, browserHeaders(request));
    reply.header("set-cookie", result.cookie);
    return result.response;
  });
  app.post("/v1/session/restore", async (request) => {
    const { appId, deploymentId } = z
      .strictObject({ appId: opaqueId, deploymentId: opaqueId })
      .parse(request.body);
    return sessions.restore(
      appId,
      deploymentId,
      cookieValue(request.headers.cookie, restorationCookieName(deploymentId)),
    );
  });
}
