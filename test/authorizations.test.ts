import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AuthorizationService } from "../src/connections/authorizations.js";
import { OperatorConnections } from "../src/connections/operator.js";
import { createHttpApp } from "../src/http/app.js";
import { registerAuthorizationRoutes } from "../src/http/authorization-routes.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { randomSecret, verifier } from "../src/security/secrets.js";
import { candidate, coreFixture, fixtureProvider } from "./core-fixture.js";

test("OAuth uses one browser-bound exchange and atomically publishes; cancellation fences a late token and preserves uncertainty", async () => {
  const f = await coreFixture();
  const directory = await mkdtemp(join(tmpdir(), "tableau-provider-tls-"));
  const keyPath = join(directory, "key.pem"),
    certPath = join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const ca = await readFile(certPath, "utf8");
  let calls = 0,
    hold = false;
  let release: () => void = () => {};
  let contacted: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createServer(
    { key: await readFile(keyPath), cert: ca },
    async (request, response) => {
      assert.equal(request.url, "/token");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("client_id"), "fixture-client");
      assert.ok(form.get("code_verifier"));
      calls++;
      contacted();
      if (hold) await gate;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ access_token: "new-token" }));
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const origin = `https://127.0.0.1:${address.port}`;
  const provider = {
    ...fixtureProvider,
    endpoints: { api: { baseUrl: origin, privateCidrs: ["127.0.0.1/32"], tlsCa: ca } },
    oauth: {
      metadata: {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
      },
      clientId: "fixture-client",
      callbackUri: "https://service.example/v1/authorizations/callback/fixture",
      scope: "read",
      pkce: true,
      launchMayInvalidate: false,
      exchangeMayInvalidate: true,
      async parseTokenResponse(raw: unknown) {
        assert.deepEqual(raw, { access_token: "new-token" });
        return candidate("new-token");
      },
    },
  };
  const service = new AuthorizationService(
    f.db,
    f.access,
    f.credentials,
    new ProviderRegistry([provider]),
    f.secrets,
    { maxSockets: 4, connectTimeoutMs: 1000, headersTimeoutMs: 5000, stallTimeoutMs: 1000 },
    60000,
    10000,
  );
  const app = await createHttpApp({ db: f.db });
  registerAuthorizationRoutes(app, service, "https://service.example");
  const headers = { authorization: `Bearer ${f.alice.token}` };
  const begin = async (replacement?: {
    connectionId: string;
    expectedAuthorityGeneration: number;
  }) => {
    const proof = randomSecret();
    const response = await app.inject({
      method: "POST",
      url: "/v1/apps/one/authorizations",
      headers,
      payload: {
        providerRegistrationId: "fixture",
        initiationVerifier: verifier(proof),
        ...(replacement ? { replacement } : {}),
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const attempt = response.json();
    const page = await app.inject({ url: `/v1/authorizations/${attempt.id}/launch` });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Waiting for the initiating Data App/);
    const launch = await app.inject({
      method: "POST",
      url: `/v1/authorizations/${attempt.id}/launch`,
      payload: { initiationProof: proof },
    });
    assert.equal(launch.statusCode, 200, launch.body);
    const state = new URL(launch.json().authorizationUrl).searchParams.get("state") ?? "";
    const cookie = String(launch.headers["set-cookie"]).split(";")[0];
    assert.ok(cookie);
    return { id: attempt.id as string, state, cookie };
  };
  try {
    const first = await begin();
    const callback = `/v1/authorizations/callback/fixture?state=${first.state}&code=code`;
    assert.equal((await app.inject({ url: callback })).statusCode, 401);
    assert.equal(calls, 0);
    const results = await Promise.all(
      [1, 2].map(() => app.inject({ url: callback, headers: { cookie: first.cookie } })),
    );
    assert.equal(results.filter((result) => result.statusCode === 200).length, 1);
    assert.equal(calls, 1);
    const view = await service.view(f.alice.access, first.id);
    assert.equal(view.state, "succeeded");
    assert.ok(view.connectionId);
    assert.equal((await service.view(f.alice.access, first.id)).connectionId, view.connectionId);
    await assert.rejects(service.view(f.bob.access, first.id), { status: 404 });
    // A second attempt holds provider I/O while the initiating owner cancels.
    hold = true;
    const second = await begin({ connectionId: view.connectionId, expectedAuthorityGeneration: 1 });
    const contactedPromise = new Promise<void>((resolve) => {
      contacted = resolve;
    });
    const pending = service.callback(
      "fixture",
      new URLSearchParams({ state: second.state, code: "late-code" }),
      second.cookie.split("=")[1],
      new AbortController().signal,
    );
    await contactedPromise;
    assert.equal((await service.cancel(f.alice.access, second.id)).state, "cancelled");
    release();
    await assert.rejects(pending, { code: "stale-mutation" });
    const row = await f.db
      .selectFrom("connections")
      .selectAll()
      .where("id", "=", view.connectionId)
      .executeTakeFirstOrThrow();
    assert.equal(row.credential_generation, 1);
    assert.equal(row.state, "renewal-uncertain");
    assert.equal((await service.view(f.alice.access, second.id)).state, "cancelled");
    await f.db
      .updateTable("provider_registrations")
      .set({ mode: "operator" })
      .where("id", "=", "fixture")
      .execute();
    const shared = { ...provider, mode: "operator" as const };
    const sharedRegistry = new ProviderRegistry([shared]);
    const operators = new OperatorConnections(
      f.db,
      f.credentials,
      sharedRegistry,
      service.policy,
      { operationMs: 60000, leaseMs: 10000 },
      new Set(["operator"]),
    );
    const sharedService = new AuthorizationService(
      f.db,
      f.access,
      f.credentials,
      sharedRegistry,
      f.secrets,
      service.policy,
      60000,
      10000,
      operators,
    );
    const proof = randomSecret();
    const sharedAttempt = await sharedService.beginOperator(
      "operator",
      "one",
      { providerRegistrationId: "fixture", initiationVerifier: verifier(proof) },
      [{ deploymentId: "cloud", siteId: "site", subjectId: "alice" }],
    );
    const sharedLaunch = await sharedService.launch(sharedAttempt.id, proof);
    const sharedState = new URL(sharedLaunch.authorizationUrl).searchParams.get("state") ?? "";
    await sharedService.callback(
      "fixture",
      new URLSearchParams({ state: sharedState, code: "operator-code" }),
      sharedLaunch.browserSecret,
      new AbortController().signal,
    );
    const sharedView = await sharedService.viewOperator("operator", "one", sharedAttempt.id);
    assert.equal(sharedView.state, "succeeded");
    assert.ok(sharedView.connectionId);
    assert.equal(await f.access.connectionVisible(f.alice.access, sharedView.connectionId), true);
    assert.equal(await f.access.connectionVisible(f.bob.access, sharedView.connectionId), false);
    await assert.rejects(sharedService.view(f.alice.access, sharedAttempt.id), { status: 404 });
  } finally {
    release();
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
