import type { FastifyInstance } from "fastify";
import { invalid, ServiceError } from "../../platform/errors.ts";
import { caller } from "../auth.ts";
import { redirect, sendErrorPage, sendOpenerPage } from "../pages.ts";
import { objectBody, param } from "../request.ts";
import type { Services } from "../services.ts";
import { signInSession } from "./identity.ts";

export function connectionRoutes(app: FastifyInstance, services: Services): void {
  const { connections, identity } = services;

  app.get("/v1/definitions", async (request) => ({
    definitions: await connections.listForApp(await caller(identity, request)),
  }));

  app.post("/v1/definitions/:id/connect", async (request, reply) => {
    const principal = await caller(identity, request);
    const started = await connections.startConnect(principal, param(request, "id"), "personal");
    return reply.status(201).send({ ...started, expiresAt: started.expiresAt.toISOString() });
  });

  app.put("/v1/definitions/:id/credential", async (request) => {
    const principal = await caller(identity, request);
    if (request.url.includes("?")) throw invalid([{ path: "query", rule: "not-allowed" }]);
    const body = objectBody(request);
    return {
      definition: await connections.setPersonalCredential(
        principal,
        param(request, "id"),
        body.credential,
      ),
    };
  });

  app.delete("/v1/definitions/:id/connection", async (request) => {
    const principal = await caller(identity, request);
    return { disconnected: await connections.disconnectOwn(principal, param(request, "id")) };
  });

  // The connect page: the sign-in cookie's identity must be the one that started the connect.
  app.get("/connect/:transactionId", async (request, reply) => {
    const transactionId = param(request, "transactionId");
    try {
      const session = await signInSession(services, request);
      if (!session)
        return redirect(
          reply,
          `/tableau/sign-in?return=${encodeURIComponent(`/connect/${transactionId}`)}`,
        );
      const url = await connections.beginConnect(transactionId, session);
      return redirect(reply, url.href);
    } catch (error) {
      return sendErrorPage(reply, error, {
        type: "tableau-service:connect",
        transactionId,
        status: "failed",
        code: error instanceof ServiceError ? error.code : "internal-error",
      });
    }
  });

  app.get("/v1/oauth/callback", async (request, reply) => {
    const params = new URL(request.url, services.publicOrigin).searchParams;
    try {
      const session = await signInSession(services, request);
      const completed = await connections.completeConnect({ query: params, session });
      return sendOpenerPage(
        reply,
        {
          type: "tableau-service:connect",
          transactionId: completed.transactionId,
          definitionId: completed.definitionId,
          status: "connected",
        },
        "Connected",
        "The connection is ready. You can close this window.",
      );
    } catch (error) {
      return sendErrorPage(reply, error, {
        type: "tableau-service:connect",
        transactionId: "",
        status: "failed",
        code: error instanceof ServiceError ? error.code : "internal-error",
      });
    }
  });
}
