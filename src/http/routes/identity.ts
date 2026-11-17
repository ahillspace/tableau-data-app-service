import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isUuid } from "../../identity/sessions.ts";
import { TABLEAU_CALLBACK_PATH, TABLEAU_CLIENT_PATH } from "../../identity/tableau-cloud.ts";
import { invalid, ServiceError } from "../../platform/errors.ts";
import { pkceChallenge, randomToken } from "../../platform/secrets.ts";
import { caller } from "../auth.ts";
import {
  CONSOLE_TX_COOKIE,
  clearCookie,
  OPERATOR_COOKIE,
  RESTORE_COOKIE,
  readCookie,
  SIGN_IN_COOKIE,
  setCookie,
  TABLEAU_TX_COOKIE,
} from "../cookies.ts";
import {
  escapeHtml,
  redirect,
  scriptJson,
  sendErrorPage,
  sendOpenerPage,
  sendPage,
} from "../pages.ts";
import { objectBody, param, query } from "../request.ts";
import type { Services } from "../services.ts";

function sessionBody(principal: Awaited<ReturnType<typeof caller>>) {
  return {
    kind: principal.kind,
    identity: principal.identity,
    siteContentUrl: principal.siteContentUrl,
    userName: principal.userName,
    appId: principal.appId,
    attribution: principal.attribution,
    location: principal.location,
    expiresAt: principal.expiresAt.toISOString(),
  };
}

/** Sends the browser through Tableau sign-in and back to `returnTo` on the service. */
async function toTableau(
  services: Services,
  reply: FastifyReply,
  returnTo: string,
  deploymentId?: string,
): Promise<FastifyReply> {
  const deployments = services.identity.deploymentIds();
  const chosen = deploymentId ?? (deployments.length === 1 ? deployments[0] : undefined);
  if (!chosen) return sendDeploymentChoice(reply, deployments, returnTo);
  const begun = await services.identity.beginTableauSignIn({ deploymentId: chosen, returnTo });
  setCookie(reply, TABLEAU_TX_COOKIE, begun.browserToken, { sameSite: "Lax", maxAgeSeconds: 600 });
  return redirect(reply, begun.authorizationUrl.href);
}

function sendDeploymentChoice(
  reply: FastifyReply,
  deployments: string[],
  returnTo: string,
): FastifyReply {
  const links = deployments
    .map((id) => {
      const href = `/tableau/sign-in?deployment=${encodeURIComponent(id)}&return=${encodeURIComponent(returnTo)}`;
      return `<li><a href="${escapeHtml(href)}">${escapeHtml(id)}</a></li>`;
    })
    .join("");
  return sendPage(reply, {
    title: "Choose a Tableau Cloud pod",
    body: `<h1>Choose a Tableau Cloud pod</h1><ul>${links}</ul>`,
  });
}

export async function signInSession(services: Services, request: FastifyRequest) {
  return await services.identity.readSignInSession(readCookie(request, SIGN_IN_COOKIE));
}

export function identityRoutes(app: FastifyInstance, services: Services): void {
  const { identity } = services;

  // ---- App sign-in ----

  app.post("/v1/app-sign-ins", async (request, reply) => {
    const body = objectBody(request);
    const started = await identity.startAppSignIn({
      proofHash: body.proofHash,
      appId: body.appId,
      attribution: body.attribution,
    });
    return reply.status(201).send({
      transactionId: started.transactionId,
      url: `${services.publicOrigin}/sign-in/${started.transactionId}`,
      expiresAt: started.expiresAt.toISOString(),
    });
  });

  // The popup. It runs only with an opener, so a link sent to a viewer cannot complete someone else's sign-in.
  app.get("/sign-in/:transactionId", async (request, reply) => {
    const transactionId = param(request, "transactionId");
    if (!(await identity.appSignInPending(transactionId)))
      return sendErrorPage(
        reply,
        new ServiceError(
          400,
          "sign-in-transaction-invalid",
          "This sign-in has expired; start again from the Data App",
        ),
      );
    const session = await signInSession(services, request);
    if (!session) return toTableau(services, reply, `/sign-in/${transactionId}`);
    // The code is issued by a form post from the page itself, after the page has confirmed it has an opener.
    return sendPage(reply, {
      title: "Signing in",
      body: `<h1>Signing in</h1><p id="status">Finishing sign-in as ${escapeHtml(session.userName)}.</p><form id="complete" method="post" action="/sign-in/${escapeHtml(transactionId)}"></form>`,
      script: `if (!window.opener) { document.getElementById("status").textContent = "Open this page from the Data App to sign in."; } else { document.getElementById("complete").submit(); }`,
    });
  });

  app.post("/sign-in/:transactionId", async (request, reply) => {
    const transactionId = param(request, "transactionId");
    const session = await signInSession(services, request);
    if (!session) return toTableau(services, reply, `/sign-in/${transactionId}`);
    try {
      const code = await identity.issueCompletionCode(transactionId, session);
      return sendPage(reply, {
        title: "Signed in",
        body: `<h1>Signed in</h1><p id="status">You can close this window.</p>`,
        script: `if (!window.opener) { document.getElementById("status").textContent = "Open this page from the Data App to sign in."; } else { window.opener.postMessage(${scriptJson({ type: "tableau-service:sign-in", transactionId, code })}, "*"); window.close(); }`,
      });
    } catch (error) {
      return sendErrorPage(reply, error);
    }
  });

  app.post("/v1/app-sign-ins/:transactionId/redeem", async (request, reply) => {
    const body = objectBody(request);
    const redeemed = await identity.redeemAppSignIn(param(request, "transactionId"), {
      code: body.code,
      proof: body.proof,
    });
    setCookie(reply, RESTORE_COOKIE, redeemed.restoreToken, {
      sameSite: "None",
      partitioned: true,
      expiresAt: redeemed.principal.expiresAt,
    });
    return reply.send({ bearer: redeemed.bearer, session: sessionBody(redeemed.principal) });
  });

  app.post("/v1/session/restore", async (request, reply) => {
    const body = objectBody(request);
    const restored = await identity.restore(readCookie(request, RESTORE_COOKIE), {
      appId: body.appId,
      attribution: body.attribution,
    });
    return reply.send({ bearer: restored.bearer, session: sessionBody(restored.principal) });
  });

  app.get("/v1/session", async (request) => sessionBody(await caller(identity, request)));

  // ---- Tableau sign-in ----

  app.get("/tableau/sign-in", async (request, reply) => {
    const returnTo = query(request, "return") ?? "/tableau/signed-in";
    try {
      return await toTableau(services, reply, returnTo, query(request, "deployment"));
    } catch (error) {
      return sendErrorPage(reply, error);
    }
  });

  app.get(TABLEAU_CLIENT_PATH, async () => identity.clientMetadata());

  app.get(TABLEAU_CALLBACK_PATH, async (request, reply) => {
    const browserToken = readCookie(request, TABLEAU_TX_COOKIE);
    clearCookie(reply, TABLEAU_TX_COOKIE, { sameSite: "Lax" });
    try {
      const params = new URL(request.url, services.publicOrigin).searchParams;
      const completed = await identity.completeTableauSignIn({ query: params, browserToken });
      setCookie(reply, SIGN_IN_COOKIE, completed.cookie, {
        sameSite: "Lax",
        expiresAt: completed.session.expiresAt,
      });
      return redirect(reply, completed.returnTo, 303);
    } catch (error) {
      return sendErrorPage(reply, error);
    }
  });

  app.get("/tableau/signed-in", async (request, reply) => {
    const session = await signInSession(services, request);
    if (!session) return toTableau(services, reply, "/tableau/signed-in");
    return sendPage(reply, {
      title: "Signed in",
      body: `<h1>Signed in</h1><p>Signed in to Tableau as ${escapeHtml(session.userName)} on ${escapeHtml(session.siteContentUrl || "the default site")}. You can close this window.</p>`,
    });
  });

  // ---- Operator sign-in ----

  app.get("/operator-sign-in", async (request, reply) => {
    try {
      const transaction = query(request, "transaction");
      if (transaction === undefined) {
        const mode =
          query(request, "mode") === "console"
            ? "console"
            : query(request, "mode") === "popup"
              ? "popup"
              : "loopback";
        if (mode === "console" && !services.consoleEnabled)
          throw new ServiceError(404, "not-found", "No such route");
        const verifier = mode === "console" ? randomToken() : undefined;
        const id = await identity.beginOperatorSignIn({
          mode,
          redirectUri: query(request, "redirect_uri"),
          codeChallenge: verifier ? pkceChallenge(verifier) : query(request, "code_challenge"),
          state: query(request, "state"),
        });
        if (verifier)
          setCookie(reply, CONSOLE_TX_COOKIE, verifier, { sameSite: "Lax", maxAgeSeconds: 600 });
        return redirect(reply, `/operator-sign-in?transaction=${id}`, 303);
      }
      if (!isUuid(transaction)) throw invalid([{ path: "transaction", rule: "format:uuid" }]);
      const session = await signInSession(services, request);
      if (!session)
        return await toTableau(services, reply, `/operator-sign-in?transaction=${transaction}`);
      if (
        (await identity.operatorSignInMode(transaction)) === "console" &&
        !services.consoleEnabled
      )
        throw new ServiceError(404, "not-found", "No such route");
      const prepared = await identity.prepareOperatorConsent(transaction, session);
      const target =
        prepared.mode === "loopback"
          ? `the command-line tool on this computer (${escapeHtml(prepared.redirectUri ?? "")})`
          : prepared.mode === "console"
            ? "the operator console on this service"
            : "the tool that opened this window";
      return sendPage(reply, {
        title: "Approve operator access",
        // The approval redirects to the loopback address, and form-action governs that redirect too.
        ...(prepared.redirectUri ? { formAction: [new URL(prepared.redirectUri).origin] } : {}),
        body: `<h1>Approve operator access</h1><p>${escapeHtml(session.userName)}, this gives ${target} full operator access to this Tableau Data App Service: definitions, credentials, trusted sites, operators and every Job.</p><form method="post" action="/operator-sign-in"><input type="hidden" name="transaction" value="${escapeHtml(transaction)}"><input type="hidden" name="consent" value="${escapeHtml(prepared.consent)}"><div class="actions"><button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button></div></form>`,
      });
    } catch (error) {
      return sendErrorPage(reply, error);
    }
  });

  app.post("/operator-sign-in", async (request, reply) => {
    try {
      const form = objectBody(request);
      const transaction = typeof form.transaction === "string" ? form.transaction : "";
      const session = await signInSession(services, request);
      if (!session)
        return await toTableau(
          services,
          reply,
          `/operator-sign-in?transaction=${encodeURIComponent(transaction)}`,
        );
      const mode = await identity.operatorSignInMode(transaction);
      if (mode === "console" && !services.consoleEnabled)
        throw new ServiceError(404, "not-found", "No such route");
      if (form.decision !== "approve" && mode === "console")
        return redirect(reply, "/console?auth=denied", 303);
      if (form.decision !== "approve")
        return sendErrorPage(
          reply,
          new ServiceError(403, "operator-sign-in-denied", "Operator access was not approved"),
        );
      const approved = await identity.approveOperatorSignIn(
        transaction,
        typeof form.consent === "string" ? form.consent : undefined,
        session,
      );
      if (approved.mode === "console") {
        const verifier = readCookie(request, CONSOLE_TX_COOKIE);
        const redeemed = await identity.redeemOperatorCode({ code: approved.code, verifier });
        clearCookie(reply, CONSOLE_TX_COOKIE, { sameSite: "Lax" });
        setCookie(reply, OPERATOR_COOKIE, redeemed.bearer, {
          sameSite: "Strict",
          expiresAt: redeemed.principal.expiresAt,
        });
        return redirect(reply, "/console", 303);
      }
      if (approved.mode === "loopback") {
        const target = new URL(approved.redirectUri as string);
        target.searchParams.set("code", approved.code);
        if (approved.state !== null) target.searchParams.set("state", approved.state);
        return redirect(reply, target.href, 303);
      }
      return sendOpenerPage(
        reply,
        { type: "tableau-service:operator-sign-in", code: approved.code, state: approved.state },
        "Operator access approved",
        "Return to the tool that opened this window.",
      );
    } catch (error) {
      return sendErrorPage(reply, error);
    }
  });

  app.post("/v1/operator-sign-ins/token", async (request, reply) => {
    const body = objectBody(request);
    const redeemed = await identity.redeemOperatorCode({
      code: body.code,
      verifier: body.verifier ?? body.code_verifier,
    });
    return reply.send({ bearer: redeemed.bearer, session: sessionBody(redeemed.principal) });
  });
}
