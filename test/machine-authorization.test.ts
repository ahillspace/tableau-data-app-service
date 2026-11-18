import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { sql } from "kysely";
import { type CliDeps, tdas } from "../src/cli/tdas.ts";
import { openCredential } from "../src/connections/store.ts";
import type {
  ClientAuthentication,
  ConnectResult,
  DefinitionWrite,
} from "../src/contracts/operator.ts";
import {
  type IntakeHarness,
  IntakeProvider,
  intakeHarness,
  signingKey,
  tokenResponse,
} from "./support/intake-providers.ts";

const METHODS = ["none", "client_secret_basic", "client_secret_post", "private_key_jwt"] as const;

async function fixture(t: TestContext) {
  const provider = await new IntakeProvider().start();
  const h = await intakeHarness(provider);
  t.after(async () => {
    await h.close();
    await provider.close();
  });
  return { provider, h };
}

function machine(
  h: IntakeHarness,
  provider: IntakeProvider,
  id: string,
  method: ClientAuthentication["method"],
): DefinitionWrite {
  return h.definition(id, {
    authentication: {
      method: "client_credentials",
      tokenEndpoint: `${provider.origin}/token`,
      clientAuthentication:
        method === "private_key_jwt"
          ? {
              method,
              clientId: "machine-client",
              jwt: {
                algorithm: "RS256",
                issuer: "machine-client",
                subject: "machine-client",
                audience: `${provider.origin}/token`,
                ttlSeconds: 300,
              },
            }
          : { method, clientId: "machine-client" },
      scopeParameter: { name: "scope", separator: " " },
      response: tokenResponse,
    },
    secrets:
      method === "none"
        ? {}
        : method === "private_key_jwt"
          ? { signingPrivateKey: signingKey().privateKey }
          : { clientSecret: "synthetic-machine-client-secret" },
  });
}

function rotation(method: ClientAuthentication["method"]) {
  return method === "private_key_jwt"
    ? { signingPrivateKey: signingKey().privateKey }
    : method === "none"
      ? { signingSecret: null }
      : { clientSecret: "synthetic-rotated-machine-client-secret" };
}

async function mutate(h: IntakeHarness, id: string, body: object, secrets = false) {
  const view = await h.view(id);
  const response = await h.request(`/v1/admin/definitions/${id}${secrets ? "/secrets" : ""}`, {
    method: secrets ? "PUT" : "PATCH",
    json: { expectedVersion: view.version, ...body },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).definition;
}

async function currentConnection(h: IntakeHarness, id: string) {
  return h.db
    .selectFrom("connections")
    .selectAll()
    .where("definition_id", "=", id)
    .where("status", "<>", "disconnected")
    .executeTakeFirstOrThrow();
}

async function connect(h: IntakeHarness, provider: IntakeProvider, id: string) {
  const requests = provider.requests.length;
  const response = await h.request(`/v1/admin/definitions/${id}/connect`, { method: "POST" });
  assert.equal(response.status, 201, await response.clone().text());
  const result: ConnectResult = await response.json();
  assert.equal(result.kind, "connected");
  assert.deepEqual(Object.keys(result).sort(), ["connectionId", "definitionId", "kind"]);
  assert.equal(result.definitionId, id);
  assert.equal(provider.requests.length, requests, "authorization makes no provider request");
  const row = await currentConnection(h, id);
  assert.equal(row.id, result.connectionId);
  assert.deepEqual(openCredential(h.sealer, row.id, row.sealed!), {});
  assert.equal((await h.view(id)).setup.state, "ready");
  return result;
}

async function acquire(h: IntakeHarness, provider: IntakeProvider, id: string, token: string) {
  provider.expect(
    "/token",
    (request) => {
      assert.equal(request.form.get("grant_type"), "client_credentials");
    },
    { json: { access_token: token, expires_in: 3600 } },
  );
  provider.expect("/native", (request) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
  });
  const response = await h.native(id);
  assert.equal(response.status, 200, await response.clone().text());
  await response.text();
}

async function blocked(h: IntakeHarness, provider: IntakeProvider, id: string, code: string) {
  const requests = provider.requests.length;
  const response = await h.native(id);
  assert.equal(response.status, 403);
  assert.deepEqual((await response.json()).error, {
    code,
    message:
      code === "not-connected"
        ? "There is no connection for this definition"
        : "The connection needs authorization again",
    upstream: "not-sent",
  });
  assert.equal(provider.requests.length, requests);
  assert.deepEqual((await h.view(id)).setup, {
    state: "needs-setup",
    missing: ["authorization"],
    actions: ["connect"],
  });
}

for (const method of METHODS) {
  test(`${method} machine authorization survives rotation and remains ended across unrelated mutations`, async (t) => {
    const { provider, h } = await fixture(t);
    const id = "machine";
    await h.create(machine(h, provider, id, method));
    assert.equal(provider.requests.length, 0);
    await acquire(h, provider, id, "synthetic-first-machine-token");
    const initial = await currentConnection(h, id);
    h.identity.clock.offsetMs += 1000;
    await mutate(h, id, { secrets: rotation(method) }, true);
    await acquire(h, provider, id, "synthetic-rotated-machine-token");
    const rotated = await currentConnection(h, id);
    assert.equal(rotated.id, initial.id);
    assert.equal(rotated.authorized_at.getTime(), initial.authorized_at.getTime());
    const replaced = await connect(h, provider, id);
    assert.notEqual(replaced.connectionId, initial.id);
    assert.equal(
      (
        await h.db
          .selectFrom("connections")
          .select("sealed")
          .where("id", "=", initial.id)
          .executeTakeFirstOrThrow()
      ).sealed,
      null,
    );
    await acquire(h, provider, id, "synthetic-reconnected-machine-token");
    const disconnected = await h.request(`/v1/admin/connections/${replaced.connectionId}`, {
      method: "DELETE",
    });
    assert.equal(disconnected.status, 200);
    assert.deepEqual(await disconnected.json(), { disconnected: true });
    await blocked(h, provider, id, "not-connected");
    for (const [body, secrets] of [
      [{ displayName: "Renamed machine" }, false],
      [{ secrets: { signingSecret: null } }, true],
      [{ secrets: rotation(method) }, true],
    ] as const) {
      await mutate(h, id, body, secrets);
      await blocked(h, provider, id, "not-connected");
    }
    await connect(h, provider, id);
    await mutate(h, id, { credential: null }, true);
    await blocked(h, provider, id, "not-connected");
    for (const [body, secrets] of [
      [{ displayName: "Renamed cleared machine" }, false],
      [{ secrets: { signingSecret: null } }, true],
      [{ secrets: rotation(method) }, true],
    ] as const) {
      await mutate(h, id, body, secrets);
      await blocked(h, provider, id, "not-connected");
    }
    assert.equal(provider.count("/token"), 3);
    provider.assertComplete();
  });

  test(`${method} expired machine authorization requires explicit connect before lazy acquisition`, async (t) => {
    const { provider, h } = await fixture(t);
    const id = "interval";
    await h.create({ ...machine(h, provider, id, method), reauthorizationInterval: 60 });
    await acquire(h, provider, id, "synthetic-before-interval-token");
    const initial = await currentConnection(h, id);
    const now = h.identity.clock.now;
    const boundary = new Date(initial.authorized_at.getTime() + 60_000);
    h.identity.clock.now = () => boundary;
    try {
      const safe = await h.view(id);
      assert.deepEqual(safe.setup, {
        state: "needs-setup",
        missing: ["authorization"],
        actions: ["connect"],
      });
      assert.equal(safe.credential.set, true);
      assert.equal(safe.connectionCounts.needsAuthorization, 1);
      await blocked(h, provider, id, "needs-authorization");
      await mutate(h, id, { secrets: rotation(method) }, true);
      await blocked(h, provider, id, "needs-authorization");
      const lapsed = await currentConnection(h, id);
      assert.equal(lapsed.authorized_at.getTime(), initial.authorized_at.getTime());
      assert.equal(lapsed.status, "needs-authorization");
      const recovered = await connect(h, provider, id);
      assert.notEqual(recovered.connectionId, initial.id);
      assert.equal((await currentConnection(h, id)).authorized_at.getTime(), boundary.getTime());
      await acquire(h, provider, id, "synthetic-after-interval-token");
      const audit = await h.request("/v1/admin/audit");
      assert.ok((await audit.text()).includes('"action":"connection.connect"'));
      assert.equal(provider.count("/token"), 2);
      provider.assertComplete();
    } finally {
      h.identity.clock.now = now;
    }
  });

  test(`${method} staged application material needs explicit connect while create and redefine initialize complete setup`, async (t) => {
    const { provider, h } = await fixture(t);
    const definition = machine(h, provider, "staged", method);
    const staged = await h.create({ ...definition, secrets: {}, credential: null });
    const field = method === "private_key_jwt" ? "signingPrivateKey" : "clientSecret";
    assert.deepEqual(staged.setup, {
      state: "needs-setup",
      missing: method === "none" ? ["authorization"] : [`secrets.${field}`],
      actions: method === "none" ? ["connect"] : ["set-secrets", "connect"],
    });
    if (method !== "none") {
      const failed = await h.request(`/v1/admin/definitions/${definition.id}/connect`, {
        method: "POST",
      });
      assert.equal(failed.status, 400);
      assert.deepEqual((await failed.json()).error.fields, [
        { path: `secrets.${field}`, rule: "required" },
      ]);
      await mutate(h, definition.id, { secrets: definition.secrets }, true);
    }
    await blocked(h, provider, definition.id, "not-connected");
    await connect(h, provider, definition.id);
    await acquire(h, provider, definition.id, "synthetic-staged-machine-token");
    const version = (await h.view(definition.id)).version;
    const redefined = await h.request(`/v1/admin/definitions/${definition.id}`, {
      method: "PUT",
      json: { ...definition, expectedVersion: version },
    });
    assert.equal(redefined.status, 200, await redefined.clone().text());
    const redefinedView = (await redefined.json()).definition;
    assert.equal(redefinedView.setup.state, "ready");
    assert.equal(redefinedView.generation, staged.generation + 1);
    const row = await currentConnection(h, definition.id);
    assert.equal(row.generation, redefinedView.generation);
    assert.deepEqual(openCredential(h.sealer, row.id, row.sealed!), {});
    await acquire(h, provider, definition.id, "synthetic-redefined-machine-token");
    const cleared = await h.request(`/v1/admin/definitions/${definition.id}`, {
      method: "PUT",
      json: { ...definition, expectedVersion: redefinedView.version, credential: null },
    });
    assert.equal(cleared.status, 200, await cleared.clone().text());
    await blocked(h, provider, definition.id, "not-connected");
    assert.equal(provider.count("/token"), 2);
    provider.assertComplete();
  });
}

test("machine connect refuses disabled, retired, personal and unauthorized callers", async (t) => {
  const { provider, h } = await fixture(t);
  const definition = machine(h, provider, "machine", "none");
  await h.create({ ...definition, credential: null });
  await h.create({ ...definition, id: "disabled", enabled: false });
  const retired = await h.create({ ...definition, id: "retired" });
  await h.request("/v1/admin/definitions/retired/retire", {
    method: "POST",
    json: { expectedVersion: retired.version },
  });
  await h.create(
    h.definition("personal", { ownership: "personal", authentication: { method: "static" } }),
  );
  await h.create(h.definition("static", { authentication: { method: "static" } }));
  for (const [id, expected, code] of [
    ["disabled", 403, "definition-disabled"],
    ["retired", 403, "definition-disabled"],
    ["personal", 409, "personal-definition"],
    ["static", 409, "connect-not-supported"],
  ] as const) {
    const response = await h.request(`/v1/admin/definitions/${id}/connect`, { method: "POST" });
    assert.equal(response.status, expected);
    assert.equal((await response.json()).error.code, code);
  }
  assert.equal(
    (await h.request("/v1/definitions/machine/connect", { method: "POST", bearer: h.app.bearer }))
      .status,
    409,
  );
  assert.equal(
    (
      await h.request("/v1/admin/definitions/machine/connect", {
        method: "POST",
        bearer: h.app.bearer,
      })
    ).status,
    403,
  );
  await assert.rejects(h.definitions.connectMachine(h.app.principal, "machine"), {
    code: "operator-required",
  });
  await h.db.deleteFrom("operators").execute();
  await assert.rejects(h.definitions.connectMachine(h.operator.principal, "machine"), {
    code: "operator-required",
  });
  assert.equal(
    (
      await h.db
        .selectFrom("connections")
        .select("id")
        .where("definition_id", "=", "machine")
        .execute()
    ).length,
    0,
  );
  assert.equal(provider.requests.length, 0);
  provider.assertComplete();
});

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "waiting for the competing transaction to reach its lock");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("machine connect holds current operator authority until its connection commits", async (t) => {
  const { provider, h } = await fixture(t);
  await h.create({ ...machine(h, provider, "machine", "none"), credential: null });
  await h.db.connection().execute(async (holder) => {
    const slot = "connection:machine:shared";
    await sql`select pg_advisory_lock(hashtextextended(${slot}, 0))`.execute(holder);
    const connecting = h.request("/v1/admin/definitions/machine/connect", { method: "POST" });
    const waiting = async (type: string) => {
      const result = await sql<{ waiting: boolean }>`select exists (
        select 1 from pg_locks where not granted and locktype = ${type}
      ) as waiting`.execute(h.db);
      return result.rows[0]!.waiting;
    };
    try {
      await until(() => waiting("advisory"));
      let removed = false;
      const removal = h.db
        .deleteFrom("operators")
        .execute()
        .then(() => {
          removed = true;
        });
      await until(
        async () => removed || (await waiting("transactionid")) || (await waiting("tuple")),
      );
      assert.equal(removed, false);
      await sql`select pg_advisory_unlock(hashtextextended(${slot}, 0))`.execute(holder);
      const response = await connecting;
      assert.equal(response.status, 201, await response.clone().text());
      await removal;
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended(${slot}, 0))`.execute(holder);
    }
  });
  assert.equal((await currentConnection(h, "machine")).status, "connected");
  await assert.rejects(h.definitions.connectMachine(h.operator.principal, "machine"), {
    code: "operator-required",
  });
  assert.equal(provider.requests.length, 0);
  provider.assertComplete();
});

test("tdas definitions connect completes machine authorization synchronously and opens OAuth redirects", async (t) => {
  const { provider, h } = await fixture(t);
  await h.create({ ...machine(h, provider, "machine", "none"), credential: null });
  await h.create(
    h.definition("oauth", {
      authentication: {
        method: "authorization_code",
        authorizationEndpoint: `${provider.origin}/authorize`,
        tokenEndpoint: `${provider.origin}/token`,
        clientAuthentication: { method: "none", clientId: "browser-client" },
        scopeParameter: { name: "scope", separator: " " },
        response: tokenResponse,
        pkce: "S256",
      },
    }),
  );
  const output: string[] = [];
  const errors: string[] = [];
  const opened: string[] = [];
  const deps: CliDeps = {
    fetch,
    store: {
      get: async (key) =>
        key === "current-service" ? h.origin : key === h.origin ? h.operator.bearer : undefined,
      set: async () => {},
      delete: async () => {},
    },
    open: async (url) => {
      opened.push(url);
    },
    out: (text) => output.push(text),
    err: (text) => errors.push(text),
    env: {},
  };
  assert.equal(await tdas(["definitions", "connect", "machine"], deps), 0);
  const result = JSON.parse(output.join("\n"));
  assert.equal(result.kind, "connected");
  assert.equal(result.definitionId, "machine");
  assert.equal((await currentConnection(h, "machine")).id, result.connectionId);
  assert.deepEqual(opened, []);
  assert.deepEqual(errors, []);
  output.length = 0;
  assert.equal(await tdas(["definitions", "connect", "oauth"], deps), 0);
  assert.equal(opened.length, 1);
  assert.match(opened[0]!, /^https:\/\/service\.test\/connect\//);
  assert.equal(output.join("\n"), opened[0]);
  assert.match(errors.join("\n"), /Approve the shared connection/);
  assert.equal(provider.requests.length, 0);
  provider.assertComplete();
});
