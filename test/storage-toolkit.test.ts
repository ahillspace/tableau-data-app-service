import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { type CliDeps, tdas } from "../src/cli/tdas.ts";
import { discoveryRoutes } from "../src/http/routes/discovery.ts";
import type { Services } from "../src/http/services.ts";
import { pkceChallenge } from "../src/platform/secrets.ts";
import { createService, ServiceError } from "../src/sdk/index.ts";
import { StorageGraphQLError, workspace } from "../src/sdk/storage.ts";

const origin = "https://service.example";
const id = "c5d73e3d-d0a6-48a9-926f-6718cf16d947";
const path = `/v1/storage/workspaces/${id}`;
const authorization = "Tableau-Service-Authorization";
const session = {
  identity: { deploymentId: "cloud", siteId: "site", userId: "author" },
  appId: "tdas-cli",
  attribution: {},
  expiresAt: "2099-01-01T00:00:00Z",
};

function cli(fetch: CliDeps["fetch"], open: CliDeps["open"] = async () => assert.fail()) {
  const credentials = new Map<string, string>();
  const out: string[] = [];
  const err: string[] = [];
  return {
    credentials,
    out,
    err,
    async run(...args: string[]) {
      out.length = 0;
      err.length = 0;
      return tdas(args, {
        fetch,
        open,
        store: {
          get: async (account) => credentials.get(account),
          set: async (account, value) => {
            credentials.set(account, value);
          },
          delete: async (account) => {
            credentials.delete(account);
          },
        },
        out: (text) => out.push(text),
        err: (text) => err.push(text),
        env: {},
      });
    },
  };
}

const body = (init?: RequestInit) => JSON.parse(String(init?.body));

test("CLI viewer login redeems from a verified loopback and keeps the operator record distinct", async () => {
  let loopback: { redirectUri: string; state: string } | undefined;
  let challenge: string | undefined;
  let redirectOutsideService = false;
  const authorizations: (string | null)[] = [];
  const t = cli(
    async (request, init) => {
      const url = new URL(String(request));
      assert.equal(url.origin, origin);
      assert.equal(init?.redirect, "manual");
      switch (url.pathname) {
        case "/v1/app-sign-ins": {
          assert.equal(init?.method, "POST");
          const started = body(init);
          assert.equal(started.appId, "tdas-cli");
          assert.equal(new Headers(init.headers).has(authorization), false);
          loopback = started.loopback;
          challenge = started.proofHash;
          return Response.json({
            transactionId: "cli-sign-in",
            url: redirectOutsideService
              ? "https://wrong.example/sign-in/cli-sign-in"
              : `${origin}/sign-in/cli-sign-in`,
          });
        }
        case "/v1/app-sign-ins/cli-sign-in/redeem": {
          const { code, proof } = body(init);
          assert.equal(code, "viewer-code");
          assert.equal(pkceChallenge(proof), challenge);
          return Response.json({ bearer: "viewer-token", session });
        }
        case "/v1/operator-sign-ins/token":
          assert.equal(body(init).code, "operator-code");
          assert.equal(pkceChallenge(body(init).verifier), challenge);
          return Response.json({ bearer: "operator-token", session });
        case "/v1/discovery":
          authorizations.push(new Headers(init?.headers).get(authorization));
          return Response.json({});
        default:
          assert.fail(`Unexpected request to ${url.pathname}`);
      }
    },
    async (address) => {
      const url = new URL(address);
      assert.equal(url.origin, origin);
      let code = "viewer-code";
      if (url.pathname === "/operator-sign-in") {
        loopback = {
          redirectUri: url.searchParams.get("redirect_uri") ?? "",
          state: url.searchParams.get("state") ?? "",
        };
        challenge = url.searchParams.get("code_challenge") ?? "";
        code = "operator-code";
      } else {
        assert.equal(url.pathname, "/sign-in/cli-sign-in");
      }
      assert.ok(loopback);
      const callback = new URL(loopback.redirectUri);
      assert.equal(callback.hostname, "127.0.0.1");
      assert.equal(callback.pathname, "/callback");
      callback.searchParams.set("code", "wrong-code");
      callback.searchParams.set("state", "wrong-state");
      assert.equal((await fetch(callback)).status, 400);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", loopback.state);
      assert.equal((await fetch(callback)).status, 200);
    },
  );
  assert.equal(await t.run("login", "--service", origin), 0, t.err.join("\n"));
  assert.equal(await t.run("login", "--viewer", "--service", origin), 0, t.err.join("\n"));
  assert.doesNotMatch(t.out.join("\n"), /viewer-token/);
  assert.equal(await t.run("discover", "--viewer"), 0);
  assert.equal(await t.run("discover", "--operator"), 0);
  assert.equal(await t.run("discover"), 0);
  assert.deepEqual(authorizations, ["Bearer viewer-token", "Bearer operator-token", null]);
  assert.equal(await t.run("logout", "--viewer"), 0);
  assert.equal(await t.run("discover", "--viewer"), 2);
  assert.equal(await t.run("discover", "--operator"), 0);
  assert.equal(authorizations.at(-1), "Bearer operator-token");
  redirectOutsideService = true;
  assert.equal(await t.run("login", "--viewer", "--service", origin), 1);
  assert.match(t.err.join("\n"), /outside the service origin/);
});

test("CLI recovers workspace creation after a lost response and refuses a different creator", async (test) => {
  const temp = await mkdtemp(join(tmpdir(), "tdas-storage-cli-"));
  test.after(() => rm(temp, { recursive: true, force: true }));
  const file = join(temp, "tdas-storage.json");
  const initial = { id, label: "purchasing", revision: 0, roles: { reader: "r", editor: "e" } };
  let login = session.identity.userId;
  let key: string | undefined;
  let creates = 0;
  const t = cli(async (request, init) => {
    const url = new URL(String(request));
    assert.equal(url.origin, origin);
    assert.equal(new Headers(init?.headers).get(authorization), "Bearer viewer-token");
    if (url.pathname === "/v1/session")
      return Response.json({ ...session, identity: { ...session.identity, userId: login } });
    assert.equal(url.pathname, "/v1/storage/workspaces");
    assert.equal(init?.method, "POST");
    const { label, creationKey } = body(init);
    assert.equal(label, initial.label);
    assert.match(creationKey, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    assert.equal(JSON.parse(await readFile(file, "utf8")).creation.key, creationKey);
    if (++creates === 1) {
      key = creationKey;
      throw new Error("Lost the response after commit");
    }
    assert.equal(creationKey, key);
    return Response.json({ workspace: initial });
  });
  t.credentials.set("viewer-current-service", origin);
  t.credentials.set(`viewer:${origin}`, "viewer-token");
  const create = (...args: string[]) =>
    t.run("storage", "create", "--config", file, "--name", "purchasing", ...args);
  assert.equal(await create(), 1);
  assert.match(t.err.join("\n"), /Lost the response/);
  assert.equal(JSON.parse(await readFile(file, "utf8")).workspaceId, undefined);
  login = "different-author";
  assert.equal(await create(), 2);
  assert.equal(creates, 1);
  login = session.identity.userId;
  assert.equal(await create(), 0, t.err.join("\n"));
  const config = JSON.parse(await readFile(file, "utf8"));
  assert.equal(config.service, origin);
  assert.equal(config.workspaceId, id);
  assert.deepEqual(config.roles, initial.roles);
  assert.ok((await stat(join(temp, "migrations"))).isDirectory());
  assert.doesNotMatch(JSON.stringify(config), /viewer-token/);
});

test("CLI forwards revision and access preconditions and separates Storage operator commands", async (test) => {
  const temp = await mkdtemp(join(tmpdir(), "tdas-storage-commands-"));
  test.after(() => rm(temp, { recursive: true, force: true }));
  const migrations = join(temp, "migrations");
  const sqlFile = join(migrations, "001.sql");
  const config = join(temp, "tdas-storage.json");
  const schemaFile = join(temp, "schema.graphql");
  const graphFile = join(temp, "request.graphql");
  const accessFile = join(temp, "access.json");
  await mkdir(migrations);
  await writeFile(sqlFile, "select $1;\n");
  await writeFile(config, JSON.stringify({ service: origin, workspaceId: id }));
  await writeFile(graphFile, "query Rows($take: Int!) { allRows(first: $take) { totalCount } }");
  await writeFile(accessFile, JSON.stringify({ version: 4, site: null, grants: [] }));
  const calls: { pathname: string; method?: string; payload?: unknown }[] = [];
  const graphFailure = { data: { allRows: null }, errors: [{ message: "Unavailable" }] };
  const t = cli(async (request, init) => {
    const { pathname } = new URL(String(request));
    assert.equal(
      new Headers(init?.headers).get(authorization),
      pathname.startsWith("/v1/admin/") ? "Bearer operator-token" : "Bearer viewer-token",
    );
    calls.push({
      pathname,
      method: init?.method ?? "GET",
      payload: init?.body ? body(init) : undefined,
    });
    switch (pathname) {
      case path:
        return Response.json({
          workspace: { revision: 8, migrations: [{ id: "001", predecessor: 0 }] },
        });
      case `${path}/schema`:
        return Response.json({ revision: 8, sdl: "type Query { id: ID! }\n" });
      case `${path}/access`:
        return Response.json(
          { error: { code: "storage-access-conflict" }, requestId: "test" },
          { status: 409 },
        );
      case `${path}/graphql`:
        return Response.json(graphFailure);
      default:
        return Response.json({});
    }
  });
  t.credentials.set("current-service", origin);
  t.credentials.set(origin, "operator-token");
  t.credentials.set("viewer-current-service", origin);
  t.credentials.set(`viewer:${origin}`, "viewer-token");
  const command = (...args: string[]) => t.run("storage", ...args, "--config", config);
  assert.equal(await command("migrate", "--file", sqlFile), 0);
  assert.deepEqual(calls.at(-1), {
    pathname: `${path}/migrations`,
    method: "POST",
    payload: { id: "001", predecessor: 0, sql: "select $1;\n" },
  });
  assert.equal(
    await command("migrate", "--file", sqlFile, "--migration-id", "002", "--predecessor", "8"),
    0,
  );
  assert.deepEqual(calls.at(-1)?.payload, { id: "002", predecessor: 8, sql: "select $1;\n" });
  assert.equal(await command("query", "--file", sqlFile, "--values", "[null,5]"), 0);
  assert.deepEqual(calls.at(-1)?.payload, { sql: "select $1;\n", values: [null, 5] });
  assert.equal(await command("schema", "--output", schemaFile), 0);
  assert.equal(await readFile(schemaFile, "utf8"), "type Query { id: ID! }\n");
  assert.equal(await command("access", "--file", accessFile), 1);
  assert.deepEqual(calls.at(-1)?.payload, { version: 4, site: null, grants: [] });
  assert.match(t.err.join("\n"), /storage-access-conflict/);
  assert.equal(
    await command(
      "graphql",
      "--file",
      graphFile,
      "--operation-name",
      "Rows",
      "--variables",
      '{"take":5}',
    ),
    1,
  );
  assert.deepEqual(JSON.parse(t.err.join("\n")), graphFailure);
  assert.deepEqual(calls.at(-1)?.payload, {
    query: await readFile(graphFile, "utf8"),
    variables: { take: 5 },
    operationName: "Rows",
  });
  assert.equal(await t.run("storage", "suspend", id), 0);
  assert.equal(await t.run("storage", "suspend", id, "--viewer"), 2);
  assert.deepEqual(calls.at(-1), {
    pathname: `/v1/admin/storage/workspaces/${id}`,
    method: "PATCH",
    payload: { state: "suspended" },
  });
  const beforePurge = calls.length;
  assert.equal(await t.run("storage", "purge", id), 2);
  assert.equal(await t.run("storage", "purge", id, "--confirm", "different"), 2);
  assert.equal(calls.length, beforePurge);
  assert.equal(await t.run("storage", "purge", id, "--confirm", id), 0);
  assert.deepEqual(calls.at(-1), {
    pathname: `/v1/admin/storage/workspaces/${id}`,
    method: "DELETE",
    payload: { confirm: id },
  });
});

test("optional browser Storage SDK binds variables and surfaces GraphQL errors on HTTP 200", async () => {
  let send = 0;
  const responses = [
    () => Response.json({ data: { row: { title: "paper" } } }),
    () => Response.json({ data: { row: null }, errors: [{ message: "denied", path: ["row"] }] }),
    () =>
      Response.json(
        { error: { code: "storage-unavailable", message: "Unavailable" } },
        { status: 503 },
      ),
  ];
  const graph = "query One($id: UUID!) { row(id: $id) { title } }";
  const service = createService({
    origin,
    appId: "purchasing",
    attribution: {},
    fetch: async (request, init) => {
      const url = new URL(String(request));
      if (url.pathname === "/v1/session/restore")
        return Response.json({ bearer: "viewer-token", session });
      assert.equal(url.pathname, `${path}/graphql`);
      assert.equal(new Headers(init?.headers).get(authorization), "Bearer viewer-token");
      assert.equal(init?.redirect, "manual");
      assert.deepEqual(body(init), { query: graph, variables: { id }, operationName: "One" });
      const next = responses[send++];
      assert.ok(next);
      return next();
    },
  });
  const request = () =>
    workspace(service, id).graphql<{ row: { title: string } }>(graph, { id }, "One");
  assert.equal((await request()).row.title, "paper");
  await assert.rejects(request(), (error) => {
    assert.ok(error instanceof StorageGraphQLError);
    assert.deepEqual(error.errors, [{ message: "denied", path: ["row"] }]);
    assert.deepEqual(error.data, { row: null });
    return true;
  });
  await assert.rejects(request(), (error) => {
    assert.ok(error instanceof ServiceError);
    assert.equal(error.code, "storage-unavailable");
    return true;
  });
  assert.equal(send, 3);
});

test("discovery serves version-matched CLI and optional Storage SDK assets with hashes", async (test) => {
  const app = Fastify();
  test.after(() => app.close());
  const services: Pick<Services, "services"> = {
    services: [
      {
        id: "storage",
        contractHref: "/docs/storage",
        publicHref: "/docs/storage",
        mounted: { routes: () => {}, discover: () => undefined },
      },
      { id: "disabled", contractHref: "/docs/disabled", publicHref: "/docs/disabled" },
    ],
  };
  await discoveryRoutes(app, services as Services);
  const discovery = (await app.inject("/v1/discovery")).json();
  assert.deepEqual(discovery.publicServices, [{ id: "storage", href: "/docs/storage" }]);
  assert.equal(discovery.services, undefined);
  assert.equal(discovery.cli.version, discovery.serverVersion);
  const archive = await app.inject(discovery.cli.href);
  assert.equal(archive.statusCode, 200);
  assert.equal(createHash("sha256").update(archive.rawPayload).digest("hex"), discovery.cli.sha256);
  for (const key of ["sdk", "sdkTypes", "storageSdk", "storageSdkTypes", "filesSdkTypes"]) {
    const href = discovery.links[key];
    assert.ok(href);
    const file = await app.inject(href);
    assert.equal(file.statusCode, 200);
    assert.equal(
      createHash("sha256").update(file.rawPayload).digest("hex"),
      discovery.assetSha256[href],
    );
    if (key === "storageSdk" || key === "storageSdkTypes")
      assert.match(file.body, /StorageGraphQLError/);
    else if (key === "filesSdkTypes")
      assert.match(file.body, /FilesApi|FilesObject|upload/);
    else assert.doesNotMatch(file.body, /StorageGraphQLError/);
  }
});
