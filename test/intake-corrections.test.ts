import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { sql } from "kysely";
import type { Authentication } from "../src/contracts/operator.ts";
import { appSignIn } from "./support/identity.ts";
import {
  type IntakeHarness,
  IntakeProvider,
  intakeHarness,
  tokenResponse,
} from "./support/intake-providers.ts";

async function fixture(t: TestContext) {
  const provider = await new IntakeProvider().start();
  const h = await intakeHarness(provider);
  t.after(async () => {
    await h.close();
    await provider.close();
  });
  return { provider, h };
}
const lookup = (provider: IntakeProvider) => ({
  url: `${provider.origin}/account`,
  method: "GET" as const,
  credential: "accessToken" as const,
  encoding: "query" as const,
  response: { successStatuses: [200] },
  id: [["id"]],
});

async function connect(h: IntakeHarness, provider: IntakeProvider, id: string) {
  const start = await h.request(`/v1/admin/definitions/${id}/connect`, {
    method: "POST",
    json: {},
  });
  assert.equal(start.status, 201);
  const begun = await start.json();
  const redirect = await h.request(new URL(begun.url).pathname, { headers: { cookie: h.cookie } });
  assert.equal(redirect.status, 302);
  const url = new URL(redirect.headers.get("location") as string);
  provider.expect("/token", () => {}, {
    json: {
      access_token: "synthetic-initial-access",
      refresh_token: "synthetic-refresh",
      expires_in: 120,
    },
  });
  const callback = await h.request(
    `/v1/oauth/callback?${new URLSearchParams({
      state: url.searchParams.get("state") as string,
      code: "synthetic-code",
    })}`,
    { headers: { cookie: h.cookie } },
  );
  assert.equal(callback.status, 200, await callback.clone().text());
}

function authorization(provider: IntakeProvider): Authentication {
  return {
    method: "authorization_code",
    authorizationEndpoint: `${provider.origin}/authorize`,
    tokenEndpoint: `${provider.origin}/token`,
    clientAuthentication: { method: "none", clientId: "fixture-client" },
    pkce: "S256",
    scopeParameter: { name: "scope", separator: " " },
    response: {
      ...tokenResponse,
      mapping: { ...tokenResponse.mapping, refreshToken: ["refresh_token"] },
      rules: {
        ...tokenResponse.rules,
        rejectedGrant: [{ path: ["error"], equals: "invalid_grant" }],
      },
    },
  };
}

test("R1 disable and disabled secret writes return the committed safe view without account lookup", async (t) => {
  const { provider, h } = await fixture(t);
  provider.expect("/account", () => {}, { json: { id: "synthetic-account" } });
  const original = await h.create(
    h.definition("disable-lookup", {
      authentication: { method: "static" },
      accountLookup: lookup(provider),
      credential: { kind: "token", value: "synthetic-before-disable" },
    }),
  );
  const response = await h.request(`/v1/admin/definitions/${original.id}`, {
    method: "PATCH",
    json: { expectedVersion: original.version, enabled: false },
  });
  const committed = await h.view(original.id);
  assert.equal(
    committed.enabled,
    false,
    "the mutation committed independently of optional enrichment",
  );
  assert.equal(committed.version, original.version + 1);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).definition, committed);
  assert.equal(committed.setup.state, "disabled");
  const secret = await h.request(`/v1/admin/definitions/${original.id}/secrets`, {
    method: "PUT",
    json: {
      expectedVersion: committed.version,
      credential: { kind: "token", value: "synthetic-while-disabled" },
    },
  });
  assert.equal(secret.status, 200, await secret.clone().text());
  const rotated = (await secret.json()).definition;
  assert.equal(rotated.enabled, false);
  assert.equal(rotated.credential.set, true);
  assert.equal(rotated.version, committed.version + 1);
  assert.equal((await h.native(original.id)).status, 403);
  assert.equal(provider.count("/account"), 1, "disabled state performs no optional provider call");
  provider.assertComplete();
  await h.assertSafe(
    ["synthetic-before-disable", "synthetic-while-disabled"],
    [JSON.stringify(rotated)],
  );
});

test("R1 a disabled shared static definition can be staged with its credential and lookup", async (t) => {
  const { provider, h } = await fixture(t);
  const staged = await h.create(
    h.definition("staged-lookup", {
      enabled: false,
      authentication: { method: "static" },
      accountLookup: lookup(provider),
      credential: { kind: "token", value: "synthetic-staged-token" },
    }),
  );
  assert.equal(staged.setup.state, "disabled");
  assert.equal(staged.credential.set, true);
  assert.equal(provider.count("/account"), 0);
  provider.expect("/account", () => {}, { status: 503 });
  const enabled = await h.request(`/v1/admin/definitions/${staged.id}`, {
    method: "PATCH",
    json: { expectedVersion: staged.version, enabled: true },
  });
  assert.equal(
    enabled.status,
    200,
    "informational remote lookup failure cannot reject a committed enable",
  );
  assert.equal((await enabled.json()).definition.enabled, true);
  provider.assertComplete();
});

test("R1 optional enrichment preparation failure cannot override committed credential custody", async (t) => {
  const { provider, h } = await fixture(t);
  const open = h.sealer.open;
  h.sealer.open = () => {
    throw new Error("synthetic optional read failure");
  };
  let created;
  try {
    created = await h.create(
      h.definition("enrichment-failure", {
        authentication: { method: "static" },
        accountLookup: lookup(provider),
        credential: { kind: "token", value: "synthetic-committed-token" },
      }),
    );
  } finally {
    h.sealer.open = open;
  }
  assert.equal(created.credential.set, true);
  assert.equal((await h.view(created.id)).version, created.version);
  provider.expect("/native", (request) =>
    assert.equal(request.headers.authorization, "Bearer synthetic-committed-token"),
  );
  assert.equal((await h.native(created.id)).status, 200);
  assert.equal(provider.count("/account"), 0);
  provider.assertComplete();
  await h.assertSafe(
    ["synthetic-committed-token", "synthetic optional read failure"],
    [JSON.stringify(created)],
  );
});

test("R3 shared OAuth readiness reflects a rejected refresh while preserving stored credential metadata", async (t) => {
  const { provider, h } = await fixture(t);
  const original = await h.create(
    h.definition("shared-reauthorize", { authentication: authorization(provider) }),
  );
  await connect(h, provider, original.id);
  const connected = await h.view(original.id);
  assert.equal(connected.setup.state, "ready");
  h.identity.clock.offsetMs = 130_000;
  assert.equal(
    (await h.view(original.id)).setup.state,
    "ready",
    "an expired token with automatic refresh remains ready before a known rejection",
  );
  provider.expect(
    "/token",
    (request) => assert.equal(request.form.get("grant_type"), "refresh_token"),
    {
      status: 400,
      json: { error: "invalid_grant" },
    },
  );
  const refused = await h.native(original.id);
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.code, "needs-authorization");
  const view = await h.view(original.id);
  assert.deepEqual(
    view.credential,
    connected.credential,
    "stored custody is independent of usable authorization",
  );
  assert.deepEqual(view.setup, {
    state: "needs-setup",
    missing: ["credential"],
    actions: ["connect"],
  });
  assert.equal(view.connectionCounts.connected, 0);
  assert.equal(view.connectionCounts.needsAuthorization, 1);
  const listed = await h.request("/v1/admin/definitions");
  assert.deepEqual(
    (await listed.json()).definitions.find((d: { id: string }) => d.id === view.id).setup,
    view.setup,
  );
  const app = await h.request("/v1/definitions", { bearer: h.app.bearer });
  assert.equal(
    (await app.json()).definitions.find((d: { id: string }) => d.id === view.id).status,
    "needs-authorization",
  );
  assert.equal(provider.count("/native"), 0);
  assert.equal(provider.count("/token"), 2, "safe reads do not poll or retry the provider");
  await connect(h, provider, original.id);
  const recovered = await h.view(original.id);
  assert.equal(recovered.setup.state, "ready", "explicit reconnect recovers shared authorization");
  assert.equal(recovered.connectionCounts.connected, 1);
  assert.equal(recovered.connectionCounts.needsAuthorization, 0);
  provider.assertComplete();
});

test("R3 configured reauthorization boundaries agree across safe operator/app reads and checkout", async (t) => {
  const { provider, h } = await fixture(t);
  const view = await h.create(
    h.definition("configured-interval", {
      authentication: { method: "static" },
      reauthorizationInterval: 60,
      credential: { kind: "token", value: "synthetic-interval-token" },
    }),
  );
  const authorized = await h.db
    .selectFrom("connections")
    .select("authorized_at")
    .where("definition_id", "=", view.id)
    .executeTakeFirstOrThrow();
  const clockNow = h.identity.clock.now;
  let instant = authorized.authorized_at.getTime() + 59_999;
  h.identity.clock.now = () => new Date(instant);
  try {
    assert.equal((await h.view(view.id)).setup.state, "ready");
    provider.expect("/native", () => {});
    assert.equal((await h.native(view.id)).status, 200);
    instant++;
    const lapsed = await h.view(view.id);
    assert.equal(lapsed.credential.set, true);
    assert.equal(
      lapsed.setup.state,
      "needs-setup",
      "safe reads detect the configured boundary before checkout changes persistence",
    );
    assert.equal(lapsed.connectionCounts.connected, 0);
    assert.equal(lapsed.connectionCounts.needsAuthorization, 1);
    const status = await h.request("/v1/definitions", { bearer: h.app.bearer });
    assert.equal(
      (await status.json()).definitions.find((d: { id: string }) => d.id === view.id).status,
      "needs-authorization",
    );
    assert.equal((await h.native(view.id)).status, 403);
    assert.equal(provider.count("/native"), 1);
    assert.equal((await h.view(view.id)).setup.state, "needs-setup");
  } finally {
    h.identity.clock.now = clockNow;
  }
  provider.assertComplete();
});

test("R5 fresh authentication skips activity UPDATE statements and persists one stale observation", async (t) => {
  const { provider, h } = await fixture(t);
  const d = await h.create(h.definition("activity-count"));
  await sql`create table correction_activity_statements (n integer);
    create function correction_count_activity() returns trigger language plpgsql as $$ begin insert into correction_activity_statements values (1); return null; end $$;
    create trigger correction_activity_count after update of last_seen_at on app_sessions for each statement execute function correction_count_activity();`.execute(
    h.db,
  );
  for (let i = 0; i < 3; i++) {
    provider.expect("/native", () => {});
    const result = await h.native(d.id);
    assert.equal(result.status, 200);
    await result.text();
  }
  assert.equal(
    (
      await sql<{
        n: number;
      }>`select count(*)::integer as n from correction_activity_statements`.execute(h.db)
    ).rows[0]?.n,
    0,
  );
  h.identity.clock.offsetMs = 61_000;
  provider.expect("/native", () => {});
  assert.equal((await h.native(d.id)).status, 200);
  for (let i = 0; i < 3; i++) {
    provider.expect("/native", () => {});
    assert.equal((await h.native(d.id)).status, 200);
  }
  assert.equal(
    (
      await sql<{
        n: number;
      }>`select count(*)::integer as n from correction_activity_statements`.execute(h.db)
    ).rows[0]?.n,
    1,
  );
  const stored = await h.db
    .selectFrom("app_sessions")
    .select("last_seen_at")
    .where("id", "=", h.app.principal.sessionId)
    .executeTakeFirstOrThrow();
  assert.ok(Math.abs(h.identity.clock.now().getTime() - stored.last_seen_at.getTime()) < 1000);
  provider.assertComplete();
});

test("R5 activity-only failure preserves native authority while expired, revoked and untrusted sessions fail closed", async (t) => {
  const { provider, h } = await fixture(t);
  const d = await h.create(h.definition("activity-failure"));
  const another = await appSignIn(h.identity, h.cookie.split("=")[1] as string, "second-app");
  h.identity.clock.offsetMs = 61_000;
  await sql`create function correction_fail_activity() returns trigger language plpgsql as $$ begin raise exception 'synthetic activity observation failure'; end $$;
    create trigger correction_activity_failure before update of last_seen_at on app_sessions for each statement execute function correction_fail_activity();`.execute(
    h.db,
  );
  provider.expect("/native", () => {});
  const result = await h.native(d.id);
  assert.equal(result.status, 200, await result.clone().text());
  assert.equal(provider.count("/native"), 1);
  h.identity.clock.offsetMs = 8 * 24 * 3600_000;
  assert.equal((await h.native(d.id)).status, 401, "expiry remains authoritative");
  h.identity.clock.offsetMs = 61_000;
  await h.identity.identity.endSession(h.app.principal.sessionId);
  assert.equal((await h.native(d.id)).status, 401, "revocation remains authoritative");
  await h.assertSafe([h.app.bearer, another.bearer, "synthetic activity observation failure"]);
  await h.db
    .updateTable("trusted_sites")
    .set({ enabled: false })
    .where("id", "=", h.siteId)
    .execute();
  assert.equal(
    (await h.request(`/v1/native/${d.id}/native`, { bearer: another.bearer })).status,
    401,
    "trust remains authoritative for an otherwise live session",
  );
  assert.equal(provider.count("/native"), 1);
  provider.assertComplete();
});
