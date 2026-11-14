import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RegistryCredential } from "../access/sites.js";
import type { AuthorizationService } from "../connections/authorizations.js";
import type { OperatorConnections } from "../connections/operator.js";
import {
  authorizationBeginSchema,
  opaqueId,
  staticConnectionInputSchema,
} from "../public/schemas.js";
import { verifySecret } from "../security/secrets.js";
import { ServiceError } from "./errors.js";
import { requestAbort } from "./wire.js";

const audience = z.array(
  z.strictObject({
    deploymentId: opaqueId,
    siteId: opaqueId,
    subjectId: z.union([opaqueId, z.literal("*")]),
  }),
);
// This role provisions explicit shared accounts; it has no viewer/session or
// registry impersonation power and is never sent to a provider or popup.
export function registerOperatorRoutes(
  app: FastifyInstance,
  operators: OperatorConnections,
  authorizations: AuthorizationService,
  credentials: readonly RegistryCredential[],
) {
  const authorize = (header: string | undefined) => {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? "")?.[1];
    const actor = token && credentials.find((item) => verifySecret(token, item.verifier));
    if (!actor)
      throw new ServiceError(
        401,
        "operator-authentication-required",
        "Operator authentication required",
      );
    return actor.actorId;
  };
  app.post("/v1/operator/apps/:app/connections/static", async (request, reply) => {
    const actor = authorize(request.headers.authorization);
    const { app: appId } = z.strictObject({ app: opaqueId }).parse(request.params);
    const input = staticConnectionInputSchema.extend({ audience }).parse(request.body);
    const row = await operators.import(
      actor,
      appId,
      {
        providerRegistrationId: input.providerRegistrationId,
        inputs: input.inputs,
        audience: input.audience,
        ...(input.replacement ? { replacement: input.replacement } : {}),
      },
      requestAbort(request, reply),
    );
    reply.status(input.replacement ? 200 : 201);
    return {
      id: row.id,
      state: row.state,
      authorityGeneration: row.authority_generation,
      display: row.display,
      audience: input.audience,
    };
  });
  app.post("/v1/operator/apps/:app/authorizations", async (request, reply) => {
    const actor = authorize(request.headers.authorization);
    const { app: appId } = z.strictObject({ app: opaqueId }).parse(request.params);
    const { audience: shared, ...input } = authorizationBeginSchema
      .extend({ audience })
      .parse(request.body);
    const result = await authorizations.beginOperator(actor, appId, input, shared);
    reply.status(201);
    return result;
  });
  app.get("/v1/operator/apps/:app/authorizations/:id", async (request) => {
    const actor = authorize(request.headers.authorization);
    const { app: appId, id } = z
      .strictObject({ app: opaqueId, id: opaqueId })
      .parse(request.params);
    return authorizations.viewOperator(actor, appId, id);
  });
  app.post("/v1/operator/apps/:app/authorizations/:id/cancel", async (request) => {
    const actor = authorize(request.headers.authorization);
    const { app: appId, id } = z
      .strictObject({ app: opaqueId, id: opaqueId })
      .parse(request.params);
    return authorizations.cancelOperator(actor, appId, id);
  });
}
