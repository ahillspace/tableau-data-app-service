import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bearer } from "../access/service.js";
import { cookieValue } from "../access/sessions.js";
import type { AuthorizationService } from "../connections/authorizations.js";
import { authorizationBeginSchema, opaqueId } from "../public/schemas.js";
import { verifier } from "../security/secrets.js";
import { absent } from "./errors.js";
import { completionPage, handoffPage } from "./handoff-page.js";
import { requestAbort } from "./wire.js";

const scoped = z.strictObject({ app: opaqueId, id: opaqueId });
const correlation = (id: string) => `__Host-integration-authorization-${id}`;
export function registerAuthorizationRoutes(
  app: FastifyInstance,
  service: AuthorizationService,
  origin: string,
): void {
  app.post("/v1/apps/:app/authorizations", async (request, reply) => {
    const { app: appId } = z.strictObject({ app: opaqueId }).parse(request.params);
    const access = await service.access.authenticate(bearer(request.headers.authorization), appId);
    const view = await service.begin(access, authorizationBeginSchema.parse(request.body));
    reply.status(201);
    return { ...view, launchUrl: `${origin}/v1/authorizations/${view.id}/launch` };
  });
  app.get("/v1/apps/:app/authorizations/:id", async (request) => {
    const { app: appId, id } = scoped.parse(request.params);
    return service.view(
      await service.access.authenticate(bearer(request.headers.authorization), appId),
      id,
    );
  });
  app.post("/v1/apps/:app/authorizations/:id/cancel", async (request) => {
    const { app: appId, id } = scoped.parse(request.params);
    return service.cancel(
      await service.access.authenticate(bearer(request.headers.authorization), appId),
      id,
    );
  });
  app.get("/v1/authorizations/:id/launch", async (request, reply) => {
    const { id } = z.strictObject({ id: opaqueId }).parse(request.params);
    if (
      !(await service.db
        .selectFrom("authorizations")
        .select("id")
        .where("id", "=", id)
        .executeTakeFirst())
    )
      absent();
    return handoffPage(reply, id, `/v1/authorizations/${id}/launch`);
  });
  app.post("/v1/authorizations/:id/launch", async (request, reply) => {
    const { id } = z.strictObject({ id: opaqueId }).parse(request.params);
    const { initiationProof } = z
      .strictObject({ initiationProof: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .parse(request.body);
    const result = await service.launch(id, initiationProof);
    reply.header(
      "set-cookie",
      `${correlation(id)}=${result.browserSecret}; Secure; HttpOnly; SameSite=Lax; Path=/`,
    );
    return { authorizationUrl: result.authorizationUrl };
  });
  app.get("/v1/authorizations/callback/:registration", async (request, reply) => {
    const { registration } = z.strictObject({ registration: opaqueId }).parse(request.params);
    const parameters = new URL(request.raw.url ?? "", origin).searchParams;
    const state = parameters.get("state");
    if (!state) absent();
    const attempt = await service.db
      .selectFrom("authorizations")
      .select("id")
      .where("state_verifier", "=", verifier(state))
      .where("provider_registration_id", "=", registration)
      .executeTakeFirst();
    if (!attempt) absent();
    const id = await service.callback(
      registration,
      parameters,
      cookieValue(request.headers.cookie, correlation(attempt.id)),
      requestAbort(request, reply),
    );
    reply.header(
      "set-cookie",
      `${correlation(id)}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    );
    return completionPage(reply, id);
  });
}
