import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { type TestContext, test } from "node:test";
import { sql } from "kysely";
import type { Authentication, ClientAuthentication, Placement } from "../src/contracts/operator.ts";
import {
  deferred,
  type IntakeHarness,
  IntakeProvider,
  intakeHarness,
  signingKey,
  tokenResponse,
  verifyJwt,
} from "./support/intake-providers.ts";

const CLIENT = "fixture-client";
const SECRET = "synthetic-protocol-client-secret";
const TOKEN = "synthetic-protocol-access-token";

async function fixture(t: TestContext) {
  const provider = await new IntakeProvider().start();
  t.after(() => provider.close());
  const h = await intakeHarness(provider);
  t.after(() => h.close());
  return { provider, h };
}

function authorization(
  provider: IntakeProvider,
): Extract<Authentication, { method: "authorization_code" }> {
  return {
    method: "authorization_code",
    authorizationEndpoint: `${provider.origin}/authorize`,
    tokenEndpoint: `${provider.origin}/token`,
    refreshEndpoint: `${provider.origin}/refresh`,
    clientAuthentication: { method: "client_secret_post", clientId: CLIENT },
    pkce: "S256",
    scopeParameter: { name: "user_scope", separator: "," },
    authorizeParameters: { prompt: "consent" },
    tokenParameters: { resource: "initial" },
    refreshParameters: { resource: "refresh" },
    response: {
      ...tokenResponse,
      mapping: {
        accessToken: ["authed_user", "access_token"],
        refreshToken: ["authed_user", "refresh_token"],
        expiresIn: ["authed_user", "expires_in"],
        scope: ["authed_user", "scope"],
        scopeSeparator: ",",
        accountId: [
          ["team", "id"],
          ["enterprise", "id"],
        ],
        accountName: [["enterprise", "name"]],
      },
    },
    refreshResponse: {
      ...tokenResponse,
      mapping: {
        accessToken: ["renewal", "access"],
        refreshToken: ["renewal", "refresh"],
        expiresIn: ["renewal", "ttl"],
      },
    },
  };
}

async function beginOAuth(h: IntakeHarness, id: string) {
  const started = await h.request(`/v1/admin/definitions/${id}/connect`, {
    method: "POST",
    json: {},
  });
  assert.equal(started.status, 201);
  const begun = await started.json();
  const redirect = await h.request(new URL(begun.url).pathname, { headers: { cookie: h.cookie } });
  assert.equal(redirect.status, 302);
  const url = new URL(redirect.headers.get("location") as string);
  return {
    url,
    finish: () =>
      h.request(
        `/v1/oauth/callback?${new URLSearchParams({ state: url.searchParams.get("state") as string, code: "fixture-code" })}`,
        { headers: { cookie: h.cookie } },
      ),
  };
}

async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("authorization code uses PKCE, nested initial fields and distinct refresh mapping without replaying native requests", {
  timeout: 20_000,
}, async (t) => {
  const { provider, h } = await fixture(t);
  await h.create(
    h.definition("oauth", {
      authentication: authorization(provider),
      scopes: ["chat:write", "files:read"],
      secrets: { clientSecret: SECRET },
    }),
  );
  const begun = await beginOAuth(h, "oauth");
  assert.equal(begun.url.searchParams.get("client_id"), CLIENT);
  assert.equal(begun.url.searchParams.get("user_scope"), "chat:write,files:read");
  assert.equal(begun.url.searchParams.get("scope"), null);
  assert.equal(begun.url.searchParams.get("prompt"), "consent");
  assert.equal(begun.url.searchParams.get("code_challenge_method"), "S256");
  provider.expect(
    "/token",
    (r) => {
      assert.equal(r.method, "POST");
      assert.equal(r.form.get("grant_type"), "authorization_code");
      assert.equal(r.form.get("client_id"), CLIENT);
      assert.ok(r.form.get("client_secret") === SECRET);
      assert.equal(r.headers.authorization, undefined);
      assert.equal(r.form.get("code"), "fixture-code");
      assert.equal(r.form.get("redirect_uri"), "https://service.test/v1/oauth/callback");
      assert.equal(
        createHash("sha256")
          .update(r.form.get("code_verifier") as string)
          .digest("base64url"),
        begun.url.searchParams.get("code_challenge"),
      );
      assert.equal(r.form.get("resource"), "initial");
    },
    {
      json: {
        ok: true,
        authed_user: {
          access_token: TOKEN,
          refresh_token: "synthetic-refresh-one",
          expires_in: 120,
          scope: "chat:write,files:read",
        },
        enterprise: { id: "E1", name: "Synthetic enterprise" },
      },
    },
  );
  const connected = await begun.finish();
  assert.equal(connected.status, 200, await connected.clone().text());
  const records = (await (await h.request("/v1/admin/connections?definition=oauth")).json())
    .connections;
  assert.deepEqual(records[0].account, { id: "E1", name: "Synthetic enterprise" });
  assert.deepEqual(records[0].scopes, ["chat:write", "files:read"]);
  const authorizedAt = records[0].authorizedAt;
  provider.expect("/native", (r) => assert.ok(r.headers.authorization === `Bearer ${TOKEN}`));
  assert.equal((await h.native("oauth")).status, 200);
  h.identity.clock.offsetMs = 70_000;
  provider.expect(
    "/refresh",
    (r) => {
      assert.equal(r.form.get("grant_type"), "refresh_token");
      assert.ok(r.form.get("refresh_token") === "synthetic-refresh-one");
      assert.equal(r.form.get("resource"), "refresh");
      assert.equal(r.form.get("code"), null);
      assert.ok(r.form.get("client_secret") === SECRET);
    },
    {
      json: {
        ok: true,
        renewal: { access: "synthetic-renewed-token", refresh: "synthetic-refresh-two", ttl: 3600 },
      },
    },
  );
  provider.expect("/native", (r) =>
    assert.ok(r.headers.authorization === "Bearer synthetic-renewed-token"),
  );
  assert.equal((await h.native("oauth")).status, 200);
  const after = (await (await h.request("/v1/admin/connections?definition=oauth")).json())
    .connections[0];
  assert.equal(after.authorizedAt, authorizedAt);
  assert.equal(provider.count("/token"), 1);
  assert.equal(provider.count("/refresh"), 1);
  assert.equal(provider.count("/native"), 2);
  provider.assertComplete();
  await h.assertSafe(
    [SECRET, TOKEN, "synthetic-refresh-one", "synthetic-refresh-two"],
    [await connected.text(), JSON.stringify(after)],
  );
});

test("HTTP-200 OAuth errors and malformed successes fail safely before any native send", {
  timeout: 20_000,
}, async (t) => {
  const { provider, h } = await fixture(t);
  for (const [id, body, code] of [
    ["refused", { ok: false, access_token: TOKEN, error: SECRET }, "exchange-failed"],
    [
      "malformed",
      { ok: true, authed_user: { access_token: 123, refresh_token: SECRET } },
      "exchange-uncertain",
    ],
  ] as const) {
    await h.create(
      h.definition(id, {
        authentication: authorization(provider),
        secrets: { clientSecret: SECRET },
      }),
    );
    const begun = await beginOAuth(h, id);
    provider.expect("/token", () => {}, { json: body });
    const result = await begun.finish();
    assert.equal(result.status, 502);
    const text = await result.text();
    assert.ok(text.includes(code));
    assert.equal((await h.native(id)).status, 403);
    await h.assertSafe([SECRET, TOKEN], [text]);
  }
  assert.equal(provider.count("/native"), 0);
  provider.assertComplete();
});

test("HTTP-200 refresh errors, malformed responses and lost replies preserve honest credential outcomes", {
  timeout: 20_000,
}, async (t) => {
  const { provider, h } = await fixture(t);
  for (const fault of ["refused", "malformed", "lost", "rejected"] as const) {
    const auth = authorization(provider);
    assert.ok(auth.refreshResponse);
    auth.refreshResponse.rules = {
      ...auth.refreshResponse.rules,
      rejectedGrant: [{ path: ["error"], equals: "invalid_grant" }],
    };
    await h.create(
      h.definition(fault, { authentication: auth, secrets: { clientSecret: SECRET } }),
    );
    const begun = await beginOAuth(h, fault);
    provider.expect("/token", () => {}, {
      json: {
        ok: true,
        authed_user: {
          access_token: TOKEN,
          refresh_token: `synthetic-refresh-${fault}`,
          expires_in: 120,
        },
      },
    });
    assert.equal((await begun.finish()).status, 200);
    const before = await h.db
      .selectFrom("connections")
      .selectAll()
      .where("definition_id", "=", fault)
      .where("status", "=", "connected")
      .executeTakeFirstOrThrow();
    h.identity.clock.offsetMs += 70_000;
    const callsBefore = provider.count("/refresh");
    provider.expect(
      "/refresh",
      (r) => assert.ok(r.form.get("refresh_token") === `synthetic-refresh-${fault}`),
      fault === "lost"
        ? { drop: true }
        : {
            json:
              fault === "refused"
                ? { ok: false, error: SECRET }
                : fault === "malformed"
                  ? { ok: true, renewal: { access: 123, refresh: SECRET } }
                  : { ok: false, error: "invalid_grant", diagnostic: SECRET },
          },
    );
    const refused = await h.native(fault);
    assert.equal(refused.status, fault === "rejected" ? 403 : 502);
    const response = await refused.text();
    const error = JSON.parse(response).error;
    assert.equal(
      error.code,
      fault === "refused"
        ? "refresh-failed"
        : fault === "rejected"
          ? "needs-authorization"
          : "refresh-uncertain",
    );
    assert.equal(error.upstream, "not-sent", "the business request was never sent");
    assert.equal(
      provider.count("/refresh"),
      callsBefore + 1,
      "one caller does not automatically replay a credential operation",
    );
    const after = await h.db
      .selectFrom("connections")
      .selectAll()
      .where("id", "=", before.id)
      .executeTakeFirstOrThrow();
    assert.deepEqual(
      after.sealed,
      before.sealed,
      "failed refresh never commits a partial credential",
    );
    assert.equal(after.status, fault === "rejected" ? "needs-authorization" : "connected");
    if (fault === "rejected") {
      assert.equal((await h.native(fault)).status, 403);
      assert.equal(
        provider.count("/refresh"),
        callsBefore + 1,
        "rejected grant needs new authorization",
      );
    }
    await h.assertSafe([SECRET, TOKEN, `synthetic-refresh-${fault}`], [response]);
  }
  assert.equal(provider.count("/native"), 0);
  provider.assertComplete();
});

test("rotation waits for another pool's in-flight refresh and changes future client authentication without replacing the grant", {
  timeout: 20_000,
}, async (t) => {
  const { provider, h } = await fixture(t);
  const other = await h.replica();
  const view = await h.create(
    h.definition("refresh-rotation", {
      authentication: authorization(provider),
      secrets: { clientSecret: SECRET },
    }),
  );
  const begun = await beginOAuth(h, "refresh-rotation");
  provider.expect("/token", () => {}, {
    json: {
      ok: true,
      authed_user: {
        access_token: TOKEN,
        refresh_token: "synthetic-refresh-before-rotation",
        expires_in: 120,
      },
    },
  });
  assert.equal((await begun.finish()).status, 200);
  h.identity.clock.offsetMs = 70_000;
  const entered = deferred(),
    release = deferred();
  provider.expect(
    "/refresh",
    (r) => {
      assert.ok(r.form.get("client_secret") === SECRET);
      entered.resolve();
    },
    {
      wait: release.promise,
      json: {
        ok: true,
        renewal: {
          access: "synthetic-during-rotation",
          refresh: "synthetic-refresh-after-rotation",
          ttl: 120,
        },
      },
    },
  );
  const inFlight = h.native("refresh-rotation");
  await entered.promise;
  const rotating = other.request("/v1/admin/definitions/refresh-rotation/secrets", {
    method: "PUT",
    json: {
      expectedVersion: view.version,
      secrets: { clientSecret: "synthetic-refreshed-client-secret" },
    },
  });
  await until(
    async () =>
      (
        await sql<{
          n: number;
        }>`select count(*)::int as n from pg_stat_activity where application_name = 'intake-replica-b' and wait_event_type = 'Lock'`.execute(
          h.db,
        )
      ).rows[0]?.n === 1,
    "rotation waiting for definition/refresh authority",
  );
  provider.expect("/native", (r) =>
    assert.ok(r.headers.authorization === "Bearer synthetic-during-rotation"),
  );
  release.resolve();
  assert.equal((await inFlight).status, 200);
  assert.equal((await rotating).status, 200);
  provider.expect("/native", (r) =>
    assert.ok(r.headers.authorization === "Bearer synthetic-during-rotation"),
  );
  assert.equal(
    (await h.native("refresh-rotation")).status,
    200,
    "already-issued OAuth access token retains its grant identity",
  );
  assert.equal(provider.count("/refresh"), 1);
  h.identity.clock.offsetMs += 70_000;
  provider.expect(
    "/refresh",
    (r) => {
      assert.ok(r.form.get("client_secret") === "synthetic-refreshed-client-secret");
      assert.ok(r.form.get("refresh_token") === "synthetic-refresh-after-rotation");
    },
    { json: { ok: true, renewal: { access: "synthetic-next-refresh", ttl: 3600 } } },
  );
  provider.expect("/native", (r) =>
    assert.ok(r.headers.authorization === "Bearer synthetic-next-refresh"),
  );
  assert.equal((await h.native("refresh-rotation")).status, 200);
  assert.equal(provider.count("/refresh"), 2);
  const after = await h.view("refresh-rotation");
  assert.equal(after.generation, view.generation);
  assert.equal(after.connectionCounts.connected, 1);
  provider.assertComplete();
  await h.assertSafe([
    SECRET,
    TOKEN,
    "synthetic-refreshed-client-secret",
    "synthetic-during-rotation",
    "synthetic-next-refresh",
    "synthetic-refresh-after-rotation",
  ]);
});

for (const method of [
  "none",
  "client_secret_basic",
  "client_secret_post",
  "private_key_jwt",
] as const) {
  test(`client credentials keeps ${method} client authentication independent from header placement`, {
    timeout: 20_000,
  }, async (t) => {
    const { provider, h } = await fixture(t);
    const key = signingKey();
    const clientAuthentication: ClientAuthentication =
      method === "private_key_jwt"
        ? {
            method,
            clientId: CLIENT,
            jwt: {
              algorithm: "RS256",
              issuer: CLIENT,
              subject: CLIENT,
              audience: `${provider.origin}/token`,
              keyId: "application-key",
              ttlSeconds: 300,
            },
          }
        : { method, clientId: CLIENT };
    const secrets =
      method === "none"
        ? {}
        : method === "private_key_jwt"
          ? { signingPrivateKey: key.privateKey }
          : { clientSecret: SECRET };
    const view = await h.create(
      h.definition("machine", {
        authentication: {
          method: "client_credentials",
          tokenEndpoint: `${provider.origin}/token`,
          clientAuthentication,
          scopeParameter: { name: "permissions", separator: "," },
          tokenParameters: { resource: "fixture-resource" },
          response: tokenResponse,
        },
        credentialPlacement: { kind: "header", name: "X-Provider-Credential", prefix: "Token " },
        scopes: ["write", "read"],
        secrets,
      }),
    );
    assert.equal(view.setup.state, "ready");
    assert.equal(
      provider.requests.length,
      0,
      "setup is lazy and performs no provider business call",
    );
    provider.expect(
      "/token",
      (r) => {
        assert.equal(r.form.get("grant_type"), "client_credentials");
        assert.equal(r.form.get("permissions"), "write,read");
        assert.equal(r.form.get("resource"), "fixture-resource");
        if (method === "client_secret_basic") {
          assert.ok(
            r.headers.authorization ===
              `Basic ${Buffer.from(`${CLIENT}:${SECRET}`).toString("base64")}`,
          );
          assert.equal(r.form.get("client_secret"), null);
        } else {
          assert.equal(r.headers.authorization, undefined);
          assert.equal(r.form.get("client_id"), CLIENT);
          assert.ok(
            r.form.get("client_secret") === (method === "client_secret_post" ? SECRET : null),
          );
        }
        if (method === "private_key_jwt") {
          assert.equal(
            r.form.get("client_assertion_type"),
            "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          );
          verifyJwt(r.form.get("client_assertion") as string, {
            key: key.publicKey,
            algorithm: "RS256",
            keyId: "application-key",
            issuer: CLIENT,
            subject: CLIENT,
            audience: `${provider.origin}/token`,
            ttl: 300,
            jti: true,
          });
        } else assert.equal(r.form.get("client_assertion"), null);
        assert.equal(r.form.get("assertion"), null);
      },
      { json: { access_token: TOKEN, expires_in: 3600 } },
    );
    for (let i = 0; i < 2; i++) {
      provider.expect("/native", (r) => {
        assert.ok(r.headers["x-provider-credential"] === `Token ${TOKEN}`);
        assert.equal(r.headers.authorization, undefined);
        assert.equal(r.headers["tableau-service-authorization"], undefined);
      });
      assert.equal((await h.native("machine")).status, 200);
    }
    assert.equal(provider.count("/token"), 1, "second checkout uses the cached derived credential");
    provider.assertComplete();
    await h.assertSafe([SECRET, TOKEN, key.privateKey], [JSON.stringify(view)]);
  });
}

test("RFC 7523 grant and private_key_jwt authenticate with distinct connection and application keys", {
  timeout: 20_000,
}, async (t) => {
  const { provider, h } = await fixture(t);
  const grantKey = signingKey("ES256"),
    applicationKey = signingKey();
  await h.create(
    h.definition("assertion", {
      authentication: {
        method: "jwt_bearer",
        tokenEndpoint: `${provider.origin}/token`,
        response: tokenResponse,
        jwt: {
          algorithm: "ES256",
          issuer: { credential: "issuer" },
          subject: { credential: "subject" },
          audience: "https://issuer.example/audience",
          keyId: { credential: "keyId" },
          scope: { source: "scopes", separator: " " },
          ttlSeconds: 600,
        },
        clientAuthentication: {
          method: "private_key_jwt",
          clientId: CLIENT,
          jwt: {
            algorithm: "RS256",
            issuer: CLIENT,
            subject: CLIENT,
            audience: `${provider.origin}/token`,
            keyId: "app-kid",
            ttlSeconds: 300,
          },
        },
      },
      scopes: ["inference", "read"],
      secrets: { signingPrivateKey: applicationKey.privateKey },
      credential: {
        kind: "jwt",
        privateKey: grantKey.privateKey,
        issuer: "service-account@example.test",
        subject: "delegated@example.test",
        keyId: "grant-kid",
      },
      credentialPlacement: { kind: "query", name: "access_key" },
    }),
  );
  provider.expect(
    "/token",
    (r) => {
      assert.equal(r.form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      verifyJwt(r.form.get("assertion") as string, {
        key: grantKey.publicKey,
        algorithm: "ES256",
        keyId: "grant-kid",
        issuer: "service-account@example.test",
        subject: "delegated@example.test",
        audience: "https://issuer.example/audience",
        scope: "inference read",
        ttl: 600,
      });
      verifyJwt(r.form.get("client_assertion") as string, {
        key: applicationKey.publicKey,
        algorithm: "RS256",
        keyId: "app-kid",
        issuer: CLIENT,
        subject: CLIENT,
        audience: `${provider.origin}/token`,
        ttl: 300,
        jti: true,
      });
      assert.equal(
        r.form.get("client_assertion_type"),
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      );
      assert.equal(r.form.get("client_secret"), null);
    },
    { json: { access_token: TOKEN, expires_in: 3600 } },
  );
  provider.expect("/native", (r) => {
    assert.deepEqual(r.url.searchParams.getAll("access_key"), [TOKEN]);
    assert.equal(r.url.searchParams.get("keep"), "yes");
    assert.equal(r.headers.authorization, undefined);
  });
  assert.equal((await h.native("assertion", "/native?access_key=untrusted&keep=yes")).status, 200);
  provider.assertComplete();
  await h.assertSafe([grantKey.privateKey, applicationKey.privateKey, TOKEN]);
});

test("data-only service-account import rejects token_uri mismatch and reaches concrete global/regional native JSON and SSE", {
  timeout: 20_000,
}, async (t) => {
  const { provider, h } = await fixture(t);
  const key = signingKey();
  const catalog = await (await h.request("/v1/admin/catalog")).json();
  const template = catalog.templates.find(
    (entry: { id: string }) => entry.id === "google-service-account",
  );
  assert.ok(template, "service-account import is catalog data");
  const tokenEndpoint = `${provider.origin}/token`;
  const imported = {
    type: "service_account",
    client_email: "fixture@example.test",
    private_key: key.privateKey,
    private_key_id: "google-kid",
    token_uri: tokenEndpoint,
    ignored_sensitive_field: "synthetic-unselected-json-secret",
  };
  const configured = h.definition("service-account", {
    ...template.definition,
    id: "service-account",
    privateHosts: true,
    audience: [h.siteId],
    apiHosts: [
      provider.originFor("aiplatform.googleapis.com"),
      `https://*-aiplatform.googleapis.com:${provider.port}`,
    ],
    authentication: {
      ...template.definition.authentication,
      tokenEndpoint,
      jwt: { ...template.definition.authentication.jwt, audience: tokenEndpoint },
    },
  });
  await h.create(configured);
  const wrong = await h.request("/v1/admin/definitions/service-account/secrets", {
    method: "PUT",
    json: {
      expectedVersion: (await h.view("service-account")).version,
      credential: {
        kind: "import",
        value: JSON.stringify({ ...imported, token_uri: "https://unconfigured.example/token" }),
      },
    },
  });
  assert.equal(wrong.status, 400);
  assert.equal(provider.requests.length, 0);
  const stored = await h.request("/v1/admin/definitions/service-account/secrets", {
    method: "PUT",
    json: {
      expectedVersion: (await h.view("service-account")).version,
      credential: { kind: "import", value: JSON.stringify(imported) },
    },
  });
  assert.equal(stored.status, 200, await stored.clone().text());
  const row = await h.db
    .selectFrom("connections")
    .selectAll()
    .where("definition_id", "=", "service-account")
    .where("status", "=", "connected")
    .executeTakeFirstOrThrow();
  const opened = JSON.parse(h.sealer.open("credential", row.id, row.sealed!));
  assert.equal(
    JSON.stringify(opened).includes(imported.ignored_sensitive_field),
    false,
    "only selected import fields persist",
  );
  provider.expect(
    "/token",
    (r) => {
      assert.equal(r.form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      assert.equal(r.form.get("client_assertion"), null);
      verifyJwt(r.form.get("assertion") as string, {
        key: key.publicKey,
        algorithm: "RS256",
        keyId: "google-kid",
        issuer: imported.client_email,
        subject: imported.client_email,
        audience: tokenEndpoint,
        scope: configured.scopes.join(" "),
        ttl:
          configured.authentication.method === "jwt_bearer"
            ? configured.authentication.jwt.ttlSeconds
            : 0,
      });
    },
    { json: { access_token: TOKEN, expires_in: 3600 } },
  );
  provider.expect(
    "/v1/models:predict",
    (r) => {
      assert.equal(r.url.hostname, "aiplatform.googleapis.com");
      assert.ok(r.headers.authorization === `Bearer ${TOKEN}`);
    },
    { json: { predictions: [{ text: "synthetic result" }] } },
  );
  const normal = await h.native("service-account", "/v1/models:predict");
  assert.equal(normal.status, 200);
  assert.deepEqual(await normal.json(), { predictions: [{ text: "synthetic result" }] });
  provider.expect(
    "/v1/models:streamGenerateContent",
    (r) => {
      assert.equal(r.url.hostname, "us-central1-aiplatform.googleapis.com");
      assert.ok(r.headers.authorization === `Bearer ${TOKEN}`);
    },
    {
      headers: { "content-type": "text/event-stream" },
      body: 'data: {"text":"first"}\n\ndata: {"text":"second"}\n\n',
    },
  );
  const streaming = await h.native(
    "service-account",
    "/v1/models:streamGenerateContent",
    provider.originFor("us-central1-aiplatform.googleapis.com"),
  );
  assert.equal(streaming.status, 200);
  assert.match(streaming.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.equal(await streaming.text(), 'data: {"text":"first"}\n\ndata: {"text":"second"}\n\n');
  const refused = await h.native(
    "service-account",
    "/native",
    `https://a.b-aiplatform.googleapis.com:${provider.port}`,
  );
  assert.equal(refused.status, 400);
  assert.equal(provider.count("/token"), 1);
  provider.assertComplete();
  await h.assertSafe(
    [key.privateKey, TOKEN, imported.ignored_sensitive_field],
    [await wrong.text(), await stored.text()],
  );
});

for (const algorithm of ["RS256", "ES256"] as const) {
  test(`${algorithm} direct JWT has no exchange and changes its verified audience with selected concrete origin`, {
    timeout: 20_000,
  }, async (t) => {
    const { provider, h } = await fixture(t);
    const key = signingKey(algorithm);
    await h.create(
      h.definition("direct", {
        authentication: {
          method: "signed_jwt_direct",
          jwt: {
            algorithm,
            issuer: { credential: "issuer" },
            subject: { credential: "issuer" },
            audience: { source: "selectedOrigin" },
            keyId: { credential: "keyId" },
            ttlSeconds: 900,
          },
        },
        apiHosts: [provider.origin, provider.originFor("aiplatform.googleapis.com")],
        credential: {
          kind: "jwt",
          privateKey: key.privateKey,
          issuer: "direct-account",
          keyId: "direct-kid",
        },
      }),
    );
    const tokens: string[] = [];
    for (const host of [
      provider.origin,
      provider.originFor("aiplatform.googleapis.com"),
      provider.origin,
    ]) {
      provider.expect("/native", (r) => {
        const token = (r.headers.authorization ?? "").slice("Bearer ".length);
        verifyJwt(token, {
          key: key.publicKey,
          algorithm,
          keyId: "direct-kid",
          issuer: "direct-account",
          subject: "direct-account",
          audience: host,
          ttl: 900,
        });
        tokens.push(token);
      });
      assert.equal((await h.native("direct", "/native", host)).status, 200);
    }
    assert.notEqual(tokens[0], tokens[1]);
    assert.equal(provider.count("/token"), 0);
    provider.assertComplete();
    await h.assertSafe([key.privateKey, ...tokens]);
  });
}

for (const placement of [
  { kind: "bearer" },
  { kind: "header", name: "X-Api-Key", prefix: "Key " },
  { kind: "query", name: "api_key" },
  { kind: "basic" },
] satisfies Placement[]) {
  test(`static ${placement.kind} placement reaches the provider exactly once`, {
    timeout: 20_000,
  }, async (t) => {
    const { provider, h } = await fixture(t);
    await h.create(
      h.definition("static", {
        authentication: { method: "static" },
        credentialPlacement: placement,
        credential:
          placement.kind === "basic"
            ? { kind: "basic", username: "fixture-user", password: SECRET }
            : { kind: "token", value: TOKEN },
      }),
    );
    provider.expect("/native", (r) => {
      assert.equal(r.headers["tableau-service-authorization"], undefined);
      if (placement.kind === "bearer") assert.ok(r.headers.authorization === `Bearer ${TOKEN}`);
      if (placement.kind === "header") assert.ok(r.headers["x-api-key"] === `Key ${TOKEN}`);
      if (placement.kind === "query")
        assert.deepEqual(r.url.searchParams.getAll("api_key"), [TOKEN]);
      if (placement.kind === "basic")
        assert.ok(
          r.headers.authorization ===
            `Basic ${Buffer.from(`fixture-user:${SECRET}`).toString("base64")}`,
        );
    });
    assert.equal((await h.native("static", "/native?keep=1&api_key=attacker")).status, 200);
    assert.equal(provider.requests.length, 1);
    provider.assertComplete();
    await h.assertSafe([TOKEN, SECRET]);
  });
}

test("none and missing optional webhook secret leave native routing usable with events disabled", {
  timeout: 20_000,
}, async (t) => {
  const { provider, h } = await fixture(t);
  const view = await h.create(
    h.definition("public", {
      webhook: {
        verification: {
          kind: "hmac",
          algorithm: "sha256",
          header: "X-Signature",
          prefix: "sha256=",
          encoding: "hex",
          parts: [{ rawBody: true }],
        },
        event: { type: { literal: "event" }, account: [{ literal: "fixture" }] },
      },
    }),
  );
  assert.equal(view.setup.state, "ready");
  assert.deepEqual(view.setup.missing, []);
  assert.equal(view.secrets.signingSecret.set, false);
  provider.expect("/native", (r) => {
    assert.equal(r.headers.authorization, undefined);
    assert.equal(r.headers["tableau-service-authorization"], undefined);
  });
  assert.equal((await h.native("public")).status, 200);
  const ingress = await h.request("/v1/events/ingest/public", { method: "POST", json: {} });
  assert.equal(ingress.status, 404);
  assert.equal((await ingress.json()).error.code, "events-off");
  provider.assertComplete();
});

test("two independent pools coordinate acquisition, rotate cached client secrets, and keep disconnect authoritative", {
  timeout: 20_000,
}, async (t) => {
  const { provider, h } = await fixture(t);
  const other = await h.replica();
  const [a, b] = await Promise.all([
    sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(h.db),
    sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(other.db),
  ]);
  assert.notEqual(a.rows[0]?.pid, b.rows[0]?.pid);
  const initial = await h.create(
    h.definition("concurrent", {
      authentication: {
        method: "client_credentials",
        tokenEndpoint: `${provider.origin}/token`,
        clientAuthentication: { method: "client_secret_post", clientId: CLIENT },
        scopeParameter: { name: "scope", separator: " " },
        response: tokenResponse,
      },
      secrets: { clientSecret: SECRET },
    }),
  );
  const entered = deferred(),
    release = deferred();
  provider.expect(
    "/token",
    (r) => {
      assert.ok(r.form.get("client_secret") === SECRET);
      entered.resolve();
    },
    { wait: release.promise, json: { access_token: TOKEN, expires_in: 3600 } },
  );
  const first = h.native("concurrent");
  await entered.promise;
  const second = other.native("concurrent");
  await until(
    async () =>
      (
        await sql<{
          n: number;
        }>`select count(*)::int as n from pg_stat_activity where application_name = 'intake-replica-b' and wait_event_type = 'Lock'`.execute(
          h.db,
        )
      ).rows[0]?.n === 1,
    "second pool waiting for acquisition lock",
  );
  provider.expect("/native", (r) => assert.ok(r.headers.authorization === `Bearer ${TOKEN}`));
  provider.expect("/native", (r) => assert.ok(r.headers.authorization === `Bearer ${TOKEN}`));
  release.resolve();
  assert.deepEqual(
    (await Promise.all([first, second])).map((r) => r.status),
    [200, 200],
  );
  assert.equal(provider.count("/token"), 1);
  const rotated = await other.request("/v1/admin/definitions/concurrent/secrets", {
    method: "PUT",
    json: {
      expectedVersion: initial.version,
      secrets: { clientSecret: "synthetic-rotated-client" },
    },
  });
  assert.equal(rotated.status, 200);
  assert.equal((await rotated.json()).definition.generation, initial.generation);
  const acquiring = deferred(),
    finish = deferred();
  provider.expect(
    "/token",
    (r) => {
      assert.ok(r.form.get("client_secret") === "synthetic-rotated-client");
      acquiring.resolve();
    },
    { wait: finish.promise, json: { access_token: "synthetic-rotated-access", expires_in: 3600 } },
  );
  const inFlight = h.native("concurrent");
  await acquiring.promise;
  const connection = await h.db
    .selectFrom("connections")
    .select("id")
    .where("definition_id", "=", "concurrent")
    .where("status", "=", "connected")
    .executeTakeFirstOrThrow();
  const disconnected = other.request(`/v1/admin/connections/${connection.id}`, {
    method: "DELETE",
  });
  await until(
    async () =>
      (
        await sql<{
          n: number;
        }>`select count(*)::int as n from pg_stat_activity where application_name = 'intake-replica-b' and wait_event_type = 'Lock'`.execute(
          h.db,
        )
      ).rows[0]?.n === 1,
    "disconnect waiting for acquired credential",
  );
  provider.expect("/native", (r) =>
    assert.ok(r.headers.authorization === "Bearer synthetic-rotated-access"),
  );
  finish.resolve();
  assert.equal((await inFlight).status, 200, "lease acquired before disconnect may finish");
  assert.equal((await disconnected).status, 200);
  assert.equal((await h.native("concurrent")).status, 403);
  const ended = await other.db
    .selectFrom("connections")
    .selectAll()
    .where("id", "=", connection.id)
    .executeTakeFirstOrThrow();
  assert.equal(ended.status, "disconnected");
  assert.equal(ended.sealed, null);
  assert.equal(provider.count("/token"), 2);
  assert.equal(provider.count("/native"), 3);
  provider.assertComplete();
});

test("secret rotation on a second pool rejects an OAuth callback's stale credential commit", {
  timeout: 20_000,
}, async (t) => {
  const { provider, h } = await fixture(t);
  const other = await h.replica();
  const definition = await h.create(
    h.definition("stale", {
      authentication: authorization(provider),
      secrets: { clientSecret: SECRET },
    }),
  );
  const begun = await beginOAuth(h, "stale");
  const entered = deferred(),
    release = deferred();
  provider.expect("/token", () => entered.resolve(), {
    wait: release.promise,
    json: {
      ok: true,
      authed_user: {
        access_token: TOKEN,
        refresh_token: "synthetic-stale-refresh",
        expires_in: 3600,
      },
    },
  });
  const pending = begun.finish();
  await entered.promise;
  const rotation = await other.request("/v1/admin/definitions/stale/secrets", {
    method: "PUT",
    json: {
      expectedVersion: definition.version,
      secrets: { clientSecret: "synthetic-new-authority" },
    },
  });
  assert.equal(rotation.status, 200);
  release.resolve();
  const result = await pending;
  assert.equal(result.status, 409);
  const body = await result.text();
  assert.ok(body.includes("definition-changed"));
  assert.equal((await h.native("stale")).status, 403);
  assert.equal(
    (
      await h.db
        .selectFrom("connections")
        .select("id")
        .where("definition_id", "=", "stale")
        .execute()
    ).length,
    0,
  );
  assert.equal(provider.count("/token"), 1);
  assert.equal(provider.count("/native"), 0);
  provider.assertComplete();
  await h.assertSafe([SECRET, TOKEN, "synthetic-new-authority", "synthetic-stale-refresh"], [body]);
});
