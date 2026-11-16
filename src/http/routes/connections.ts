import type { FastifyInstance } from "fastify";
import { ServiceError } from "../../platform/errors.ts";
import { caller } from "../auth.ts";
import { escapeHtml, redirect, sendErrorPage, sendOpenerPage, sendPage } from "../pages.ts";
import { objectBody, param } from "../request.ts";
import type { Services } from "../services.ts";
import { signInSession } from "./identity.ts";

const FIELD_LABELS: Record<string, string> = {
  clientSecret: "OAuth client secret",
  signingSecret: "Event signing secret",
  credential: "Shared credential",
};

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

  // The secret entry page: an operator types a value the service seals; it is never shown again.
  app.get("/secret/:token", async (request, reply) => {
    const token = param(request, "token");
    try {
      const session = await signInSession(services, request);
      if (!session)
        return redirect(reply, `/tableau/sign-in?return=${encodeURIComponent(`/secret/${token}`)}`);
      const link = await connections.readSecretLink(token, session);
      const label = FIELD_LABELS[link.field] ?? link.field;
      return sendPage(reply, {
        title: `Enter ${label}`,
        body: `<h1>${escapeHtml(label)}</h1><p>For ${escapeHtml(link.displayName)} (${escapeHtml(link.definitionId)}). The value is sealed and never shown again.</p><form method="post" action="/secret/${escapeHtml(token)}" autocomplete="off"><input type="password" name="value" required aria-label="${escapeHtml(label)}"><div class="actions"><button type="submit">Save</button></div></form>`,
      });
    } catch (error) {
      return sendErrorPage(reply, error);
    }
  });

  app.post("/secret/:token", async (request, reply) => {
    const token = param(request, "token");
    try {
      const session = await signInSession(services, request);
      const form = objectBody(request);
      const saved = await connections.submitSecret(token, session, form.value);
      const label = FIELD_LABELS[saved.field] ?? saved.field;
      return sendPage(reply, {
        title: "Saved",
        body: `<h1>Saved</h1><p>The ${escapeHtml(label.toLowerCase())} for ${escapeHtml(saved.definitionId)} is sealed. You can close this window.</p>`,
      });
    } catch (error) {
      return sendErrorPage(reply, error);
    }
  });
}
