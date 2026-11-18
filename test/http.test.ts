/**
 * The HTTP layer end to end: a real listening API server, a cookie-jar browser that signs in at the
 * Tableau stand-in, and fetch calls shaped like the SDK's and the CLI's.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { templates } from "../src/catalog/index.ts";
import { type CliDeps, tdas } from "../src/cli/tdas.ts";
import type {
  JobHandlerDefinition,
  JobRunContext,
  JobStepResult,
} from "../src/connections/extensions.ts";
import { createEvents } from "../src/events/index.ts";
import type { EventService } from "../src/events/service.ts";
import { createApi } from "../src/http/app.ts";
import { listSites } from "../src/identity/directory.ts";
import { JobService } from "../src/jobs/service.ts";
import { JobWorker } from "../src/jobs/worker.ts";
import type { Db } from "../src/persistence/database.ts";
import { ServiceError as PlatformError } from "../src/platform/errors.ts";
import { Log } from "../src/platform/log.ts";
import { pkceChallenge, randomToken } from "../src/platform/secrets.ts";
import { NativeRouter } from "../src/router/router.ts";
import {
  createService,
  readAttribution,
  ServiceError,
  type ServiceEvent,
} from "../src/sdk/index.ts";
import { type ConnectionsHarness, connectionsHarness } from "./support/connections.ts";
import { freshDatabase, testKeys } from "./support/db.ts";
import { oauthAuthentication } from "./support/definitions.ts";
import { type IdentityHarness, identityHarness } from "./support/identity.ts";
import { OAuthStandIn } from "./support/oauth.ts";
import { TableauStandIn, type TableauUser } from "./support/tableau.ts";

const alice: TableauUser = {
  siteId: "site-a",
  siteContentUrl: "alpha",
  userId: "user-a",
  userName: "alice@example.com",
};
const bob: TableauUser = {
  siteId: "site-a",
  siteContentUrl: "alpha",
  userId: "user-b",
  userName: "bob@example.com",
};
const operatorUser: TableauUser = {
  siteId: "site-a",
  siteContentUrl: "alpha",
  userId: "user-op",
  userName: "op@example.com",
};
const SIGNING_SECRET = "http-signing-secret";
const BEARER = "Tableau-Service-Authorization";

let waitVerifier: string | undefined;
const remote: JobHandlerDefinition = {
  name: "remote",
  retrySafe: false,
  async run(ctx: JobRunContext): Promise<JobStepResult> {
    if (ctx.resume !== undefined)
      return { kind: "succeeded", result: { input: ctx.input, resumed: ctx.resume } };
    waitVerifier = (await ctx.callback()).verifier;
    return { kind: "wait", externalTaskId: "task-1" };
  },
};
const jobHandlers = [remote];

describe("http", () => {
  let tableau: TableauStandIn;
  let provider: OAuthStandIn;
  let db: Db;
  let closeDb: (() => Promise<void>) | undefined;
  let h: IdentityHarness;
  let c: ConnectionsHarness;
  let jobs: JobService;
  let events: EventService | undefined;
  let api: FastifyInstance | undefined;
  let origin: string;
  let alpha: string;
  let lines: string[];

  /** A browser: a cookie jar, manual redirects, and a Tableau user to sign in as when sent to Tableau. */
  class Browser {
    readonly jar = new Map<string, string>();
    readonly user: TableauUser;
    constructor(user: TableauUser) {
      this.user = user;
    }

    async request(path: string, init: RequestInit = {}): Promise<Response> {
      const headers = new Headers(init.headers);
      if (this.jar.size)
        headers.set("cookie", [...this.jar].map(([n, v]) => `${n}=${v}`).join("; "));
      const response = await fetch(`${origin}${path}`, { ...init, headers, redirect: "manual" });
      for (const cookie of response.headers.getSetCookie()) {
        const [pair, ...attributes] = cookie.split(";").map((p) => p.trim());
        const [name, value] = (pair as string).split("=") as [string, string];
        if (attributes.includes("Max-Age=0")) this.jar.delete(name);
        else this.jar.set(name, value);
      }
      return response;
    }

    /** Follows redirects on the service, signing in at Tableau when sent there. */
    async visit(path: string, init: RequestInit = {}): Promise<Response> {
      let response = await this.request(path, init);
      for (let hop = 0; hop < 10 && response.status >= 300 && response.status < 400; hop++) {
        const location = new URL(response.headers.get("location") as string, origin);
        if (location.origin === tableau.origin) {
          // Tableau resolves the client by fetching the metadata document at the client ID URL.
          const clientId = new URL(location.searchParams.get("client_id") as string);
          const client = await (await fetch(`${origin}${clientId.pathname}`)).json();
          response = await this.request(
            `/tableau/callback?${tableau.authorize(location, this.user, client)}`,
          );
          continue;
        }
        if (location.origin !== origin) return response;
        response = await this.request(`${location.pathname}${location.search}`);
      }
      return response;
    }

    form(path: string, fields: Record<string, string>): Promise<Response> {
      return this.request(path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      });
    }
  }

  const call = (path: string, init: RequestInit & { bearer?: string; json?: unknown } = {}) => {
    const headers = new Headers(init.headers);
    if (init.bearer) headers.set(BEARER, `Bearer ${init.bearer}`);
    if (init.json !== undefined) headers.set("content-type", "application/json");
    return fetch(`${origin}${path}`, {
      ...init,
      headers,
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      redirect: "manual",
    });
  };

  /** V26: no log line from any component holds a secret value seen during the test. */
  function assertNoSecretsLogged(secrets: string[]) {
    const all = [...lines, ...h.lines, ...c.lines].join("\n");
    assert.ok(all.length > 0, "the components logged something");
    for (const secret of secrets)
      assert.ok(!all.includes(secret), `a log line holds a secret (${secret.slice(0, 3)}...)`);
  }

  async function errorCode(response: Response): Promise<string> {
    return ((await response.json()) as { error: { code: string } }).error.code;
  }

  /** The SDK's first sign-in: start, popup, completion code, redeem. */
  async function appSignIn(browser: Browser, appId = "app-one") {
    const proof = randomToken();
    const started = await call("/v1/app-sign-ins", {
      method: "POST",
      json: { proofHash: pkceChallenge(proof), appId, attribution: { workbook: "wb" } },
    });
    assert.equal(started.status, 201);
    const { transactionId, url } = (await started.json()) as { transactionId: string; url: string };
    const popup = await browser.visit(new URL(url).pathname);
    assert.equal(popup.status, 200);
    const page = await popup.text();
    assert.match(page, /Open this page from the Data App to sign in\./);
    const completed = await browser.request(new URL(url).pathname, { method: "POST" });
    const code = /"code":"([A-Za-z0-9_-]+)"/.exec(await completed.text())?.[1];
    assert.ok(code, "completion code posted to the opener");
    const redeemed = await call(`/v1/app-sign-ins/${transactionId}/redeem`, {
      method: "POST",
      headers: { origin: "https://frame.example" },
      json: { code, proof },
    });
    assert.equal(redeemed.status, 200);
    const body = (await redeemed.json()) as { bearer: string };
    return { bearer: body.bearer, redeemed, transactionId, code, proof };
  }

  /** The CLI's loopback operator sign-in. */
  async function operatorBearer(browser: Browser): Promise<string> {
    const verifier = randomToken();
    const begin = new URLSearchParams({
      redirect_uri: "http://127.0.0.1:4555/cb",
      code_challenge: pkceChallenge(verifier),
      state: "cli-state",
    });
    const consentPage = await browser.visit(`/operator-sign-in?${begin}`);
    assert.equal(consentPage.status, 200);
    const csp = consentPage.headers.get("content-security-policy") as string;
    assert.match(csp, /form-action 'self' http:\/\/127\.0\.0\.1:4555/);
    const html = await consentPage.text();
    const field = (name: string) =>
      new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1] as string;
    const approved = await browser.form("/operator-sign-in", {
      transaction: field("transaction"),
      consent: field("consent"),
      decision: "approve",
    });
    assert.equal(approved.status, 303);
    const back = new URL(approved.headers.get("location") as string);
    assert.equal(back.origin, "http://127.0.0.1:4555");
    assert.equal(back.searchParams.get("state"), "cli-state");
    const token = await call("/v1/operator-sign-ins/token", {
      method: "POST",
      json: { code: back.searchParams.get("code"), verifier },
    });
    assert.equal(token.status, 200);
    return ((await token.json()) as { bearer: string }).bearer;
  }

  /** The operator API accepts secret values once and returns only safe metadata. */
  async function defineWithSecret(
    op: string,
    _browser: Browser,
    definition: Record<string, unknown>,
    field: string,
    value: string,
  ) {
    const created = await call("/v1/admin/definitions", {
      method: "POST",
      bearer: op,
      json: {
        ...definition,
        ...(field === "credential"
          ? { credential: { kind: "token", value } }
          : { secrets: { [field]: value } }),
      },
    });
    assert.equal(created.status, 201, await created.clone().text());
    assert.equal((await created.text()).includes(value), false);
  }

  /**
   * A browser window for the SDK: popups load in `browser`, and the opener message their final page
   * posts is delivered back as a message from the service origin.
   */
  function sdkWindow(browser: Browser, href: string) {
    const listeners = new Set<
      (event: { origin: string; source: unknown; data: unknown }) => void
    >();
    const opened: string[] = [];
    const posted = (html: string) => {
      const json = /postMessage\((\{.*?\}), "\*"\)/.exec(html)?.[1];
      return json ? JSON.parse(json) : undefined;
    };
    const win = {
      location: { href },
      document: { referrer: "" },
      addEventListener: (
        _type: string,
        fn: (event: { origin: string; source: unknown; data: unknown }) => void,
      ) => listeners.add(fn),
      removeEventListener: (
        _type: string,
        fn: (event: { origin: string; source: unknown; data: unknown }) => void,
      ) => listeners.delete(fn),
      open() {
        const popup = {
          closed: false,
          close() {
            popup.closed = true;
          },
          location: {
            set href(url: string) {
              opened.push(url);
              void (async () => {
                const path = new URL(url).pathname;
                let page: Response;
                if (path.startsWith("/connect/")) {
                  const toProvider = await browser.visit(path);
                  const authorize = new URL(toProvider.headers.get("location") as string);
                  page = await browser.request(
                    `/v1/oauth/callback?${provider.authorize(authorize)}`,
                  );
                } else {
                  await browser.visit(path);
                  page = await browser.request(path, { method: "POST" });
                }
                const data = posted(await page.text());
                for (const fn of [...listeners]) fn({ origin, source: popup, data });
              })();
            },
          },
        };
        return popup;
      },
    };
    /** The page's fetch: credentialed calls carry the browser's cookies. */
    const pageFetch = (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (init.credentials === "include")
        return browser.request(`${url.pathname}${url.search}`, init);
      return fetch(url, init);
    };
    return { win: win as unknown as Window, opened, fetch: pageFetch as typeof fetch };
  }

  async function serviceCode(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      assert.ok(error instanceof ServiceError, String(error));
      return error.code;
    }
    assert.fail("expected a ServiceError");
  }

  before(async () => {
    tableau = await new TableauStandIn().start();
    provider = await new OAuthStandIn().start();
  });
  after(async () => {
    await api?.close();
    await events?.close();
    await h.close();
    await closeDb?.();
    await provider.close();
    await tableau.close();
  });
  beforeEach(async () => {
    provider.reset();
    waitVerifier = undefined;
    await api?.close();
    await events?.close();
    if (closeDb) {
      await h.close();
      await closeDb();
    }
    ({ db, close: closeDb } = await freshDatabase());
    h = await identityHarness(db, tableau);
    c = connectionsHarness(db, {
      keys: testKeys(),
      outbound: h.outbound,
      clock: h.clock,
      jobHandlers,
    });
    lines = [];
    const log = new Log((line) => lines.push(line));
    jobs = new JobService({
      db,
      connections: c.connections,
      limits: {
        inputBytes: 4096,
        resultBytes: 4096,
        runtimeSeconds: 3600,
        resultRetentionSeconds: 86400,
        recordRetentionSeconds: 86400,
      },
      publicOrigin: "https://service.test",
      clock: h.clock,
      log,
    });
    events = await createEvents({
      redisUrl: process.env.TDAS_TEST_REDIS,
      connections: c.connections,
      clock: h.clock,
      log,
      sessionValid: (p) => h.identity.sessionActive(p.sessionId),
    });
    await events?.start();
    api = await createApi({
      db,
      publicOrigin: "https://service.test",
      identity: h.identity,
      connections: c.connections,
      router: new NativeRouter({ connections: c.connections, outbound: h.outbound, log }),
      jobs,
      events,
      log,
    });
    await api.listen({ port: 0, host: "127.0.0.1" });
    origin = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
    // The trusted site binds to its Tableau site ID at the first sign-in.
    await new Browser(operatorUser).visit("/tableau/sign-in");
    alpha = ((await listSites(db))[0] as { id: string }).id;
  });

  test("V3 the service publishes its Tableau client metadata document at its client ID URL", async () => {
    const response = await call("/tableau/client.json");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
    assert.deepEqual(await response.json(), {
      client_id: "https://service.test/tableau/client.json",
      client_name: "Data App integration service",
      redirect_uris: ["https://service.test/tableau/callback"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "openid email",
    });
    // Sign-in sends Tableau that same URL as the client ID and the document's redirect URL.
    const begun = await new Browser(alice).request("/tableau/sign-in");
    const authorize = new URL(begun.headers.get("location") as string);
    assert.equal(
      authorize.searchParams.get("client_id"),
      "https://service.test/tableau/client.json",
    );
    assert.equal(
      authorize.searchParams.get("redirect_uri"),
      "https://service.test/tableau/callback",
    );
  });

  test("V7 app sign-in over HTTP: popup needs an opener, redeem sets the partitioned restore cookie, restore needs no prompt", async () => {
    const browser = new Browser(alice);
    const { bearer, redeemed, transactionId, code, proof } = await appSignIn(browser);

    // The credentialed redeem echoes the frame's origin and allows credentials.
    assert.equal(redeemed.headers.get("access-control-allow-origin"), "https://frame.example");
    assert.equal(redeemed.headers.get("access-control-allow-credentials"), "true");
    const restoreCookie = redeemed.headers
      .getSetCookie()
      .find((s) => s.startsWith("__Host-tdas-restore="));
    assert.ok(restoreCookie);
    assert.match(restoreCookie, /SameSite=None/);
    assert.match(restoreCookie, /Partitioned/);
    assert.match(restoreCookie, /Secure/);
    assert.match(restoreCookie, /HttpOnly/);

    // The completion code is single use.
    const again = await call(`/v1/app-sign-ins/${transactionId}/redeem`, {
      method: "POST",
      json: { code, proof },
    });
    assert.equal(again.status, 400);

    const session = await call("/v1/session", { bearer });
    assert.equal(session.status, 200);
    const body = (await session.json()) as { identity: { userId: string }; appId: string };
    assert.equal(body.identity.userId, "user-a");
    assert.equal(body.appId, "app-one");
    assert.equal(session.headers.get("access-control-allow-origin"), "*");
    assert.equal(session.headers.get("cache-control"), "no-store");

    // Restore from the frame: the restore cookie alone, no popup.
    const frame = new Browser(alice);
    frame.jar.set("__Host-tdas-restore", /=([^;]+)/.exec(restoreCookie)?.[1] as string);
    const restored = await frame.request("/v1/session/restore", {
      method: "POST",
      headers: { origin: "null", "content-type": "application/json" },
      body: JSON.stringify({ appId: "app-two" }),
    });
    assert.equal(restored.status, 200);
    assert.equal(restored.headers.get("access-control-allow-origin"), "null");
    const restoredBearer = ((await restored.json()) as { bearer: string }).bearer;
    assert.notEqual(restoredBearer, bearer);
    assert.equal((await call("/v1/session", { bearer: restoredBearer })).status, 200);

    const noCookie = await call("/v1/session/restore", {
      method: "POST",
      json: { appId: "app-one" },
    });
    assert.equal(noCookie.status, 401);
    assert.equal(await errorCode(noCookie), "sign-in-required");
    assert.equal((await call("/v1/session")).status, 401);
  });

  test("V7a every operator route refuses an app bearer, and a page carries no CORS", async () => {
    const { bearer } = await appSignIn(new Browser(alice));
    const routes: [string, string][] = [
      ["GET", "/v1/admin/definitions"],
      ["POST", "/v1/admin/definitions"],
      ["PATCH", "/v1/admin/definitions/x"],
      ["PUT", "/v1/admin/definitions/x"],
      ["POST", "/v1/admin/definitions/x/retire"],
      ["PUT", "/v1/admin/definitions/x/secrets"],
      ["POST", "/v1/admin/definitions/x/connect"],
      ["GET", "/v1/admin/connections"],
      ["DELETE", "/v1/admin/connections/x"],
      ["GET", "/v1/admin/sites"],
      ["POST", "/v1/admin/sites"],
      ["PATCH", "/v1/admin/sites"],
      ["DELETE", "/v1/admin/sites"],
      ["GET", "/v1/admin/operators"],
      ["POST", "/v1/admin/operators"],
      ["DELETE", "/v1/admin/operators"],
      ["GET", "/v1/admin/apps"],
      ["POST", "/v1/admin/identities/a:b:c/revoke-sessions"],
      ["GET", "/v1/admin/jobs"],
      ["POST", "/v1/admin/jobs/x/cancel"],
      ["GET", "/v1/admin/audit"],
    ];
    for (const [method, path] of routes) {
      const refused = await call(path, {
        method,
        bearer,
        ...(method === "GET" ? {} : { json: {} }),
      });
      assert.equal(refused.status, 403, `${method} ${path}`);
      assert.equal(await errorCode(refused), "operator-required", `${method} ${path}`);
      const anonymous = await call(path, { method, ...(method === "GET" ? {} : { json: {} }) });
      assert.equal(anonymous.status, 401, `${method} ${path}`);
    }
    const page = await new Browser(alice).visit("/tableau/signed-in");
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("access-control-allow-origin"), null);
    assert.match(page.headers.get("content-security-policy") as string, /frame-ancestors 'none'/);
  });

  test("operator sign-in, trusted sites and operators over HTTP, with an audit trail", async () => {
    const op = await operatorBearer(new Browser(operatorUser));
    const sites = await call("/v1/admin/sites", { bearer: op });
    assert.equal(((await sites.json()) as { sites: unknown[] }).sites.length, 1);
    const added = await call("/v1/admin/sites", {
      method: "POST",
      bearer: op,
      json: { deploymentId: "cloud-test", contentUrl: "beta" },
    });
    assert.equal(added.status, 201);
    const beta = ((await added.json()) as { site: { id: string } }).site.id;
    const disabled = await call("/v1/admin/sites", {
      method: "PATCH",
      bearer: op,
      json: { id: beta, enabled: false },
    });
    assert.equal(((await disabled.json()) as { site: { enabled: boolean } }).site.enabled, false);
    assert.equal(
      (await call(`/v1/admin/sites?id=${beta}`, { method: "DELETE", bearer: op })).status,
      200,
    );
    const missing = await call("/v1/admin/sites", {
      method: "POST",
      bearer: op,
      json: { deploymentId: "cloud-test" },
    });
    assert.equal(missing.status, 400);
    assert.deepEqual(((await missing.json()) as { error: { fields: unknown } }).error.fields, [
      { path: "contentUrl", rule: "site-content-url" },
    ]);
    // The Default site's content URL is the empty string.
    const defaultSite = await call("/v1/admin/sites", {
      method: "POST",
      bearer: op,
      json: { deploymentId: "cloud-test", contentUrl: "" },
    });
    assert.equal(defaultSite.status, 201);
    assert.equal(
      (
        await call("/v1/admin/operators", {
          method: "POST",
          bearer: op,
          json: { deploymentId: "cloud-test", siteContentUrl: "", username: "dee@example.com" },
        })
      ).status,
      201,
    );

    const operator = await call("/v1/admin/operators", {
      method: "POST",
      bearer: op,
      json: { deploymentId: "cloud-test", siteContentUrl: "alpha", username: "bob@example.com" },
    });
    assert.equal(operator.status, 201);
    const audit = await call("/v1/admin/audit?limit=50", { bearer: op });
    const actions = ((await audit.json()) as { entries: { action: string }[] }).entries.map(
      (e) => e.action,
    );
    assert.ok(actions.includes("site.add"), actions.join(","));

    // Denying consent issues nothing.
    const browser = new Browser(operatorUser);
    const begin = new URLSearchParams({
      redirect_uri: "http://127.0.0.1:4555/cb",
      code_challenge: pkceChallenge(randomToken()),
    });
    const html = await (await browser.visit(`/operator-sign-in?${begin}`)).text();
    const field = (name: string) =>
      new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1] as string;
    const denied = await browser.form("/operator-sign-in", {
      transaction: field("transaction"),
      consent: field("consent"),
      decision: "deny",
    });
    assert.equal(denied.status, 403);

    // An app user who is not an operator reaches the consent page but cannot approve.
    const notOperator = new Browser(alice);
    const refused = await notOperator.visit(`/operator-sign-in?${begin}`);
    assert.equal(refused.status, 403);
  });

  test("V16 native passthrough over HTTP: any method, any content type, CORS and every header exposed", async () => {
    const op = await operatorBearer(new Browser(operatorUser));
    await defineWithSecret(
      op,
      new Browser(operatorUser),
      {
        id: "files",
        displayName: "Files",
        authentication: { method: "static" },
        ownership: "shared",
        apiHosts: [`${provider.origin}/api`],
        credentialPlacement: { kind: "header", name: "X-Api-Key" },
        audience: [alpha],
        privateHosts: true,
      },
      "credential",
      "key-1",
    );
    const { bearer } = await appSignIn(new Browser(alice));
    provider.apiHandler = (req, res, body) => {
      res.writeHead(207, {
        "content-type": "text/x-odd",
        "x-provider": "yes",
        "access-control-allow-origin": "https://provider.example",
      });
      res.end(
        `${req.method} ${req.url} ${req.headers["content-type"]} ${req.headers["x-api-key"]} ${body.toString()}`,
      );
    };
    const answered = await call("/v1/native/files/items/a%2Fb?x=%20y", {
      method: "PROPFIND",
      bearer,
      headers: {
        "content-type": "not a / valid type;;",
        authorization: "Native app value",
        origin: "https://frame.example",
      },
      body: "payload",
    });
    assert.equal(answered.status, 207);
    assert.equal(
      await answered.text(),
      "PROPFIND /api/items/a%2Fb?x=%20y not a / valid type;; key-1 payload",
    );
    assert.equal(answered.headers.get("access-control-allow-origin"), "*");
    assert.equal(answered.headers.get("x-provider"), "yes");
    const exposed = answered.headers.get("access-control-expose-headers") as string;
    assert.match(exposed, /x-provider/);
    assert.match(exposed, /content-type/);
    const seen = provider.apiRequests.at(-1);
    assert.equal(seen?.headers.authorization, "Native app value");
    assert.equal(seen?.headers["tableau-service-authorization"], undefined);

    // A preflight is answered by the service; any other OPTIONS goes to the provider.
    const preflight = await call("/v1/native/files/items", {
      method: "OPTIONS",
      headers: {
        origin: "https://frame.example",
        "access-control-request-method": "PROPFIND",
        "access-control-request-headers": "tableau-service-authorization, x-anything",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-methods"), "PROPFIND");
    assert.equal(
      preflight.headers.get("access-control-allow-headers"),
      "tableau-service-authorization, x-anything",
    );
    const options = await call("/v1/native/files/items", { method: "OPTIONS", bearer });
    assert.equal(options.status, 207);
    assert.equal(provider.apiRequests.at(-1)?.method, "OPTIONS");

    // Service errors on native routes are marked so the SDK can tell them from the provider's.
    const unknown = await call("/v1/native/missing/x", { bearer });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.headers.get("tableau-service-error"), "1");
    const anonymous = await call("/v1/native/files/x");
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get("tableau-service-error"), "1");
    const outside = await call("/v1/native/files/../admin", { bearer });
    assert.equal(outside.headers.get("tableau-service-error"), "1");
    // A provider's own error is not marked.
    provider.apiHandler = (_req, res) => {
      res.writeHead(500);
      res.end("provider broke");
    };
    const providerError = await call("/v1/native/files/x", { bearer });
    assert.equal(providerError.status, 500);
    assert.equal(providerError.headers.get("tableau-service-error"), null);
    assert.equal(await providerError.text(), "provider broke");
    assertNoSecretsLogged(["key-1", bearer, op]);
  });

  test("V15 the connect page refuses another identity's sign-in cookie, and the owner connects", async () => {
    const op = await operatorBearer(new Browser(operatorUser));
    await defineWithSecret(
      op,
      new Browser(operatorUser),
      {
        id: "crm",
        displayName: "CRM",
        authentication: oauthAuthentication(provider),
        ownership: "personal",
        apiHosts: [`${provider.origin}/api`],
        scopes: ["read"],
        audience: [alpha],
        privateHosts: true,
      },
      "clientSecret",
      provider.clientSecret,
    );
    const aliceBrowser = new Browser(alice);
    const { bearer } = await appSignIn(aliceBrowser);
    const started = await call("/v1/definitions/crm/connect", { method: "POST", bearer });
    assert.equal(started.status, 201);
    const connectPath = new URL(((await started.json()) as { url: string }).url).pathname;

    const bobPage = await new Browser(bob).visit(connectPath);
    assert.equal(bobPage.status, 403);
    assert.match(await bobPage.text(), /tableau-service:connect/);

    const toProvider = await aliceBrowser.visit(connectPath);
    assert.equal(toProvider.status, 302);
    const authorize = new URL(toProvider.headers.get("location") as string);
    assert.equal(authorize.origin, provider.origin);
    const done = await aliceBrowser.request(`/v1/oauth/callback?${provider.authorize(authorize)}`);
    assert.equal(done.status, 200);
    assert.match(await done.text(), /"status":"connected"/);
    assert.equal(done.headers.get("access-control-allow-origin"), null);

    const listed = await call("/v1/definitions", { bearer });
    const crm = (
      (await listed.json()) as { definitions: { id: string; status: string }[] }
    ).definitions.find((d) => d.id === "crm");
    assert.equal(crm?.status, "connected");
    const native = await call("/v1/native/crm/me", { bearer });
    assert.equal(native.status, 200);
    assert.equal(provider.apiRequests.at(-1)?.headers.authorization, "Bearer a-1");
    assert.equal(
      (
        (await (
          await call("/v1/definitions/crm/connection", { method: "DELETE", bearer })
        ).json()) as { disconnected: boolean }
      ).disconnected,
      true,
    );
    assertNoSecretsLogged([provider.clientSecret, bearer, op, "Bearer a-1"]);
  });

  test("V22 a Job is submitted, waits, resumes on a callback carrying the verifier in the service header, and returns its result", async () => {
    const op = await operatorBearer(new Browser(operatorUser));
    const created = await call("/v1/admin/definitions", {
      method: "POST",
      bearer: op,
      json: {
        id: "work",
        displayName: "Work",
        authentication: { method: "static" },
        ownership: "personal",
        apiHosts: ["https://work.example"],
        audience: [alpha],
      },
    });
    assert.equal(created.status, 201);
    const { bearer } = await appSignIn(new Browser(alice));
    assert.equal(
      (
        await call("/v1/definitions/work/credential", {
          method: "PUT",
          bearer,
          json: { credential: { kind: "token", value: "alice-key" } },
        })
      ).status,
      200,
    );

    const submit = () =>
      call("/v1/jobs", {
        method: "POST",
        bearer,
        json: { handler: "remote", definitionId: "work", input: { n: 1 }, submissionKey: "k1" },
      });
    const first = await submit();
    assert.equal(first.status, 201);
    const job = ((await first.json()) as { job: { id: string; state: string } }).job;
    assert.equal(job.state, "queued");
    const repeat = await submit();
    assert.equal(repeat.status, 200);
    assert.equal(((await repeat.json()) as { job: { id: string } }).job.id, job.id);

    const worker = new JobWorker({
      db,
      connections: c.connections,
      jobs,
      clock: h.clock,
      log: new Log(() => {}),
      concurrency: 1,
    });
    const step = async () => {
      const claimed = await worker.claim();
      assert.ok(claimed);
      await worker.execute(claimed);
    };
    await step();
    assert.equal(
      ((await (await call(`/v1/jobs/${job.id}`, { bearer })).json()) as { job: { state: string } })
        .job.state,
      "waiting",
    );
    assert.equal(
      await errorCode(await call(`/v1/jobs/${job.id}/result`, { bearer })),
      "job-not-finished",
    );

    const wrong = await call(`/v1/jobs/callbacks/${job.id}`, {
      method: "POST",
      bearer: "wrong",
      json: { done: true },
    });
    assert.equal(wrong.status, 401);
    const accepted = await call(`/v1/jobs/callbacks/${job.id}`, {
      method: "POST",
      bearer: waitVerifier as string,
      json: { done: true },
    });
    assert.equal(accepted.status, 202);
    await step();
    const result = await call(`/v1/jobs/${job.id}/result`, { bearer });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { result: { input: { n: 1 }, resumed: { done: true } } });
    assertNoSecretsLogged([waitVerifier as string, bearer, op, "alice-key"]);
    const mine = await call("/v1/jobs?state=succeeded", { bearer });
    assert.equal(((await mine.json()) as { jobs: unknown[] }).jobs.length, 1);
    const all = await call("/v1/admin/jobs", { bearer: op });
    assert.equal(((await all.json()) as { jobs: unknown[] }).jobs.length, 1);
  });

  test("events over HTTP: a signed delivery is acknowledged and reaches an open stream", async () => {
    assert.ok(events, "the test run provides Redis");
    const op = await operatorBearer(new Browser(operatorUser));
    await defineWithSecret(
      op,
      new Browser(operatorUser),
      {
        id: "slack-bot",
        displayName: "Slack",
        authentication: { method: "static" },
        apiHosts: ["https://slack.com/api", "https://files.slack.com"],
        webhook: templates[0]?.definition.webhook,
        ownership: "shared",
        audience: [alpha],
      },
      "signingSecret",
      SIGNING_SECRET,
    );
    const { bearer } = await appSignIn(new Browser(alice));
    const deadline = Date.now() + 5000;
    while (!events.ready && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));

    const controller = new AbortController();
    const stream = await call("/v1/events/stream?definitions=slack-bot", {
      bearer,
      signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") as string, /^text\/event-stream/);
    assert.equal(stream.headers.get("access-control-allow-origin"), "*");
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    let received = "";
    const readUntil = async (pattern: RegExp) => {
      while (!pattern.test(received)) {
        const { value, done } = await reader.read();
        if (done) break;
        received += Buffer.from(value).toString("utf8");
      }
      assert.match(received, pattern);
    };
    await readUntil(/event: possible-loss\ndata: \{"reason":"stream-start"\}/);

    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev-http",
      event: { type: "message" },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    const delivered = await call("/v1/events/ingest/slack-bot", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body,
    });
    assert.equal(delivered.status, 200);
    await readUntil(/"id":"Ev-http"/);

    const forged = await call("/v1/events/ingest/slack-bot", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": `v0=${"0".repeat(64)}`,
      },
      body,
    });
    assert.equal(forged.status, 401);
    const challenge = JSON.stringify({ type: "url_verification", challenge: "c-1" });
    const challengeSig = `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${challenge}`).digest("hex")}`;
    const answered = await call("/v1/events/ingest/slack-bot", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": challengeSig,
      },
      body: challenge,
    });
    assert.equal(await answered.text(), "c-1");
    assert.equal((await call("/v1/events/stream?definitions=slack-bot")).status, 401);

    // Closing the server ends the open stream instead of waiting on it, and refuses new ones.
    const closing = api?.close();
    await readUntil(/event: end\ndata: \{"reason":"service-stopping"\}/);
    await closing;
    api = undefined;
    const principal = await h.identity.authenticate(bearer);
    assert.ok(principal);
    await assert.rejects(
      events.open(principal, ["slack-bot"], { write: () => true, onDrain() {}, end() {} }),
      (error: unknown) => error instanceof PlatformError && error.code === "service-stopping",
    );
    controller.abort();
    await reader.cancel().catch(() => {});
    assertNoSecretsLogged([SIGNING_SECRET, bearer, op, signature]);
  });

  test("the tdas CLI signs in through the loopback redirect, stores the bearer, and drives the operator API", async () => {
    const stored = new Map<string, string>();
    const out: string[] = [];
    const err: string[] = [];
    const opened: string[] = [];
    const browser = new Browser(operatorUser);
    const deps: CliDeps = {
      fetch,
      store: {
        get: async (account) => stored.get(account),
        set: async (account, value) => void stored.set(account, value),
        delete: async (account) => void stored.delete(account),
      },
      // The browser signs in, approves, and follows the redirect back to the CLI's loopback listener.
      open: async (url) => {
        opened.push(url);
        const target = new URL(url);
        if (target.pathname !== "/operator-sign-in") return;
        const html = await (await browser.visit(`${target.pathname}${target.search}`)).text();
        const field = (name: string) =>
          new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1] as string;
        const approved = await browser.form("/operator-sign-in", {
          transaction: field("transaction"),
          consent: field("consent"),
          decision: "approve",
        });
        const back = await fetch(approved.headers.get("location") as string);
        assert.equal(back.status, 200);
      },
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      env: {},
    };
    const cli = async (...argv: string[]) => {
      out.length = 0;
      err.length = 0;
      const code = await tdas(argv, deps);
      return { code, json: () => JSON.parse(out.join("\n")) as Record<string, unknown> };
    };

    assert.equal((await cli("sites", "list")).code, 2);
    assert.match(err.join("\n"), /No service/);
    const login = await cli("login", "--service", origin);
    assert.equal(login.code, 0, err.join("\n"));
    assert.equal(stored.get("current-service"), origin);
    const bearer = stored.get(origin) as string;
    assert.ok(bearer);
    assert.ok(!out.join("").includes(bearer), "the bearer is never printed");
    assert.equal(((await cli("whoami")).json().identity as { userId: string }).userId, "user-op");

    const added = await cli("sites", "add", "cloud-test", "beta");
    assert.equal(added.code, 0, err.join("\n"));
    const beta = (added.json().site as { id: string }).id;
    const file = join(mkdtempSync(join(tmpdir(), "tdas-cli-")), "work.json");
    writeFileSync(
      file,
      JSON.stringify({
        id: "work",
        displayName: "Work",
        authentication: { method: "static" },
        ownership: "personal",
        apiHosts: ["https://work.example"],
        audience: [alpha],
      }),
    );
    assert.equal((await cli("definitions", "create", file)).code, 0, err.join("\n"));
    const updated = await cli(
      "definitions",
      "update",
      "work",
      "--audience",
      "add",
      "beta",
      "--audience",
      "remove",
      alpha,
    );
    assert.equal(updated.code, 0, err.join("\n"));
    assert.deepEqual((updated.json().definition as { audience: string[] }).audience, [beta]);
    assert.equal(
      (await cli("operators", "add", "cloud-test", "beta", "someone@example.com")).code,
      0,
    );
    assert.equal(((await cli("apps")).json().apps as unknown[]).length >= 0, true);
    const retired = await cli("definitions", "retire", "work");
    assert.equal(retired.code, 0);
    assert.equal((retired.json().definition as { retired: boolean }).retired, true);

    // A service error prints the error body and fails.
    const missing = await cli("definitions", "show", "nope");
    assert.equal(missing.code, 1);
    assert.match(err.join("\n"), /definition-not-found/);
    assert.equal((await cli("logout")).code, 0);
    assert.equal(stored.has(origin), false);
    assert.equal((await cli("sites", "list")).code, 2);
  });

  test("the SDK reads attribution from Tableau URLs", () => {
    assert.deepEqual(
      readAttribution("https://tableau.example/#/site/alpha/views/Sales%20Book/Sheet%201?:iid=1"),
      {
        siteContentUrl: "alpha",
        workbook: "Sales Book",
        view: "Sheet 1",
      },
    );
    assert.deepEqual(
      readAttribution("https://app.example/frame", "https://tableau.example/t/beta/views/Book"),
      {
        siteContentUrl: "beta",
        workbook: "Book",
      },
    );
    assert.deepEqual(readAttribution("not a url", ""), {});
  });

  test("the SDK signs in through a popup, restores, calls native routes, stores a credential, submits Jobs and reports a lost session", async () => {
    const op = await operatorBearer(new Browser(operatorUser));
    await defineWithSecret(
      op,
      new Browser(operatorUser),
      {
        id: "files",
        displayName: "Files",
        authentication: { method: "static" },
        ownership: "shared",
        apiHosts: [`${provider.origin}/api`],
        credentialPlacement: { kind: "header", name: "X-Api-Key" },
        audience: [alpha],
        privateHosts: true,
      },
      "credential",
      "key-1",
    );
    const work = {
      id: "work",
      displayName: "Work",
      authentication: { method: "static" },
      ownership: "personal",
      apiHosts: ["https://work.example"],
      audience: [alpha],
    };
    assert.equal(
      (await call("/v1/admin/definitions", { method: "POST", bearer: op, json: work })).status,
      201,
    );

    const browser = new Browser(alice);
    const page = sdkWindow(browser, "https://tableau.example/#/site/alpha/views/Book/Sheet");
    const service = createService({
      origin,
      appId: "sales-notes",
      window: page.win,
      fetch: page.fetch,
    });
    assert.equal(await service.restore(), false);
    assert.equal(await serviceCode(service.definitions()), "sign-in-required");

    const session = await service.signIn();
    assert.equal(page.opened.length, 1);
    assert.equal(session.identity.userId, "user-a");
    assert.equal(session.appId, "sales-notes");
    assert.deepEqual(session.attribution, {
      siteContentUrl: "alpha",
      workbook: "Book",
      view: "Sheet",
    });

    const definitions = await service.definitions();
    assert.deepEqual(definitions.map((d) => [d.id, d.ownership, d.status]).sort(), [
      ["files", "shared", "connected"],
      ["work", "personal", "not-connected"],
    ]);

    // Native responses come back as the provider sent them, errors included; service errors throw.
    provider.apiHandler = (req, res, body) => {
      res.writeHead(req.url === "/api/broken" ? 500 : 201, { "content-type": "text/plain" });
      res.end(`${req.method} ${req.headers["x-api-key"]} ${body.toString()}`);
    };
    const created = await service.fetch("files", "/items", { method: "POST", body: "hello" });
    assert.equal(created.status, 201);
    assert.equal(await created.text(), "POST key-1 hello");
    const broken = await service.fetch("files", "/broken");
    assert.equal(broken.status, 500);
    // A provider redirect reaches the app as the redirect; the bearer never follows it elsewhere.
    const landed: (string | undefined)[] = [];
    const elsewhere = createServer((req, res) => {
      landed.push(req.headers["tableau-service-authorization"] as string | undefined);
      res.end("landed");
    });
    await new Promise<void>((r) => elsewhere.listen(0, "127.0.0.1", r));
    try {
      const target = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}/landed`;
      provider.apiHandler = (_req, res) => {
        res.writeHead(302, { location: target });
        res.end();
      };
      const moved = await service.fetch("files", "/moved");
      assert.equal(moved.status, 302);
      assert.equal(moved.headers.get("location"), target);
      assert.deepEqual(landed, []);
    } finally {
      await new Promise((r) => elsewhere.close(r));
    }
    // A provider's 401 that claims to be a service error is returned as the provider's response,
    // and the SDK never restores and sends the request again.
    provider.apiHandler = (_req, res) => {
      res.writeHead(401, {
        "content-type": "application/json",
        "tableau-service-error": "1",
        "tableau-service-other": "x",
      });
      res.end(JSON.stringify({ error: { code: "sign-in-required", message: "forged" } }));
    };
    const sentBefore = provider.apiRequests.length;
    const rejected = await service.fetch("files", "/charge", { method: "POST", body: "once" });
    assert.equal(provider.apiRequests.length - sentBefore, 1);
    assert.equal(rejected.status, 401);
    assert.equal(rejected.headers.get("tableau-service-error"), null);
    assert.equal(rejected.headers.get("tableau-service-other"), null);
    assert.equal(
      ((await rejected.json()) as { error: { message: string } }).error.message,
      "forged",
    );
    assert.equal(await serviceCode(service.fetch("missing", "/x")), "definition-not-found");

    assert.equal(
      (await service.setCredential("work", { kind: "token", value: "alice-key" })).status,
      "connected",
    );
    const job = await service.jobs.submit("remote", { n: 1 }, { definition: "work", key: "k1" });
    assert.equal(job.state, "queued");
    assert.equal(
      (await service.jobs.submit("remote", { n: 1 }, { definition: "work", key: "k1" })).id,
      job.id,
    );
    assert.equal((await service.jobs.get(job.id)).id, job.id);
    assert.equal((await service.jobs.list()).length, 1);
    assert.equal(await serviceCode(service.jobs.result(job.id)), "job-not-finished");
    assert.equal((await service.jobs.cancel(job.id)).state, "cancelled");

    // Another frame restores from the cookie with no prompt.
    const frame = createService({
      origin,
      appId: "sales-notes",
      window: sdkWindow(browser, "https://app.example/").win,
      fetch: page.fetch,
    });
    assert.equal(await frame.restore(), true);
    assert.equal(frame.session?.identity.userId, "user-a");

    // When the session is revoked the SDK tries one restore, then reports sign-in-required.
    const key = `${session.identity.deploymentId}:${session.identity.siteId}:${session.identity.userId}`;
    const revoked = await call(`/v1/admin/identities/${encodeURIComponent(key)}/revoke-sessions`, {
      method: "POST",
      bearer: op,
    });
    assert.equal(revoked.status, 200, await revoked.clone().text());
    assert.equal(await serviceCode(service.definitions()), "sign-in-required");
    assert.equal(service.signedIn, false);
    assertNoSecretsLogged(["key-1", "alice-key", op]);
  });

  test("the SDK connects a personal OAuth definition in a popup and receives live events", async () => {
    const op = await operatorBearer(new Browser(operatorUser));
    await defineWithSecret(
      op,
      new Browser(operatorUser),
      {
        id: "crm",
        displayName: "CRM",
        authentication: oauthAuthentication(provider),
        ownership: "personal",
        apiHosts: [`${provider.origin}/api`],
        scopes: ["read"],
        audience: [alpha],
        privateHosts: true,
      },
      "clientSecret",
      provider.clientSecret,
    );
    const browser = new Browser(alice);
    const page = sdkWindow(browser, "https://tableau.example/#/site/alpha/views/Book/Sheet");
    const service = createService({
      origin,
      appId: "crm-app",
      window: page.win,
      fetch: page.fetch,
    });
    await service.signIn();
    const connected = await service.connect("crm");
    assert.equal(connected.status, "connected");
    assert.equal((await service.fetch("crm", "/me")).status, 200);
    assert.equal(provider.apiRequests.at(-1)?.headers.authorization, "Bearer a-1");
    assert.equal(await service.disconnect("crm"), true);
    assert.equal((await service.definition("crm"))?.status, "not-connected");

    assert.ok(events, "the test run provides Redis");
    await defineWithSecret(
      op,
      new Browser(operatorUser),
      {
        id: "slack-bot",
        displayName: "Slack",
        authentication: { method: "static" },
        apiHosts: ["https://slack.com/api", "https://files.slack.com"],
        webhook: templates[0]?.definition.webhook,
        ownership: "shared",
        audience: [alpha],
      },
      "signingSecret",
      SIGNING_SECRET,
    );
    const deadline = Date.now() + 5000;
    while (!events.ready && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const received: ServiceEvent[] = [];
    const losses: string[] = [];
    const subscription = service.events.subscribe(["slack-bot"], (event) => received.push(event), {
      onLoss: (reason) => losses.push(reason),
    });
    const until = async (check: () => boolean, what: string) => {
      const end = Date.now() + 5000;
      while (!check()) {
        if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    await until(() => losses.includes("stream-start"), "the stream to open");
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev-sdk",
      event: { type: "message" },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    const delivered = await call("/v1/events/ingest/slack-bot", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body,
    });
    assert.equal(delivered.status, 200);
    await until(() => received.length === 1, "the event");
    assert.equal(received[0]?.id, "Ev-sdk");
    assert.equal(received[0]?.definitionId, "slack-bot");
    subscription.close();

    // A refused stream ends for good with the service's code.
    let ended: string | undefined;
    service.events.subscribe(["missing"], () => {}, { onEnd: (reason) => (ended = reason) });
    await until(() => ended !== undefined, "the refusal");
    assert.equal(ended, "definition-not-found");
    assertNoSecretsLogged([provider.clientSecret, SIGNING_SECRET, op, "Bearer a-1"]);
  });

  test("health and the error shape", async () => {
    assert.equal((await call("/health/live")).status, 200);
    // The service sets no header size limit of its own.
    assert.equal(
      (await call("/health/live", { headers: { "x-big": "b".repeat(1024 * 1024) } })).status,
      200,
    );
    const ready = await call("/health/ready");
    assert.equal(ready.status, 200);
    assert.deepEqual(((await ready.json()) as { checks: Record<string, boolean> }).checks, {
      database: true,
      schema: true,
      ...(events ? { events: events.ready } : {}),
    });
    const missing = await call("/v1/nothing");
    assert.equal(missing.status, 404);
    assert.equal(await errorCode(missing), "not-found");
    const malformed = await call("/v1/app-sign-ins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.equal(await errorCode(malformed), "invalid-request");
    assert.ok(!lines.some((l) => l.includes("request failed")), lines.join("\n"));
  });
});
