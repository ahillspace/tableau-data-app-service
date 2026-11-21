import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import { loadCatalog } from "../src/catalog/index.ts";
import { Extensions } from "../src/connections/extensions.ts";
import type { DefinitionView } from "../src/contracts/operator.ts";
import type { ProviderPackage } from "../src/extensions/provider.ts";
import { createApi } from "../src/http/app.ts";
import {
  addOperator,
  addSite,
  listOperators,
  listSites,
  removeOperator,
} from "../src/identity/directory.ts";
import { JobService } from "../src/jobs/service.ts";
import { load, type Running, runApi } from "../src/main.ts";
import { ServiceError } from "../src/platform/errors.ts";
import { Log } from "../src/platform/log.ts";
import { NativeRouter } from "../src/router/router.ts";
import { connectionsHarness } from "./support/connections.ts";
import { freshDatabase, sealingKeysEnv, testKeys } from "./support/db.ts";
import { json, standIn } from "./support/https.ts";
import {
  appSignIn,
  DEPLOYMENT,
  identityHarness,
  operatorSignIn,
  SERVICE_ORIGIN,
  tableauSignIn,
} from "./support/identity.ts";
import { TableauStandIn } from "./support/tableau.ts";

const appUser = {
  siteId: "site-a",
  siteContentUrl: "alpha",
  userId: "viewer",
  userName: "viewer@example.com",
};
const operatorUser = { ...appUser, userId: "operator", userName: "op@example.com" };
const operation = "fixture.lookup.read";
const definitionHref = (id: string) => `/v1/admin/definitions/${id}`;
const capabilityHref = (id: string) => `/v1/capabilities/${id}/${operation}`;
const auth = (bearer: string) => ({ "tableau-service-authorization": `Bearer ${bearer}` });
const bootstrap = {
  publicOrigin: SERVICE_ORIGIN,
  firstSite: { deploymentId: DEPLOYMENT, contentUrl: "alpha" },
  firstOperator: {
    deploymentId: DEPLOYMENT,
    siteContentUrl: "alpha",
    username: operatorUser.userName,
  },
};

async function compileFixture(
  dir: string,
): Promise<(wait: () => Promise<void>) => ProviderPackage> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const dependencies = join(dir, "node_modules");
  await mkdir(dependencies);
  await symlink(root, join(dependencies, "tableau-data-app-service"));
  await symlink(join(root, "node_modules/zod"), join(dependencies, "zod"));
  await symlink(join(root, "node_modules/@types"), join(dependencies, "@types"));
  await copyFile(
    new URL("fixtures/operation-package.mts", import.meta.url),
    join(dir, "index.mts"),
  );
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "index.mts",
      "--ignoreConfig",
      "--strict",
      "--skipLibCheck",
      "--target",
      "es2024",
      "--module",
      "nodenext",
      "--types",
      "node",
    ],
    { cwd: dir },
  );
  const fixture = await import(pathToFileURL(join(dir, "index.mjs")).href);
  return fixture.fixturePackage;
}

test("provider package binds typed options per definition and scopes sends to the caller and generation", {
  timeout: 25000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tdas-provider-package-"));
  const database = await freshDatabase();
  const tableau = await new TableauStandIn().start();
  const identity = await identityHarness(database.db, tableau);
  const apiInstances: FastifyInstance[] = [];
  const seen: Array<{
    authorization?: string;
    label: string | undefined;
    service: string | undefined;
  }> = [];
  const provider = await standIn((request, response) => {
    if (request.url === "/api/stream") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: one\n\n");
      response.end("data: two\n\n");
      return;
    }
    const authorization = request.headers.authorization;
    seen.push({
      ...(authorization ? { authorization } : {}),
      label: request.headers["x-fixture"] as string | undefined,
      service: request.headers["tableau-service-authorization"] as string | undefined,
    });
    json(
      response,
      200,
      request.url === "/api/lookup/invalid" ? { unexpected: true } : { found: true },
    );
  });
  t.after(async () => {
    await Promise.all(apiInstances.map((app) => app.close()));
    await identity.close();
    await tableau.close();
    await provider.close();
    await database.close();
    await rm(dir, { recursive: true, force: true });
  });
  let gate = { entered: Promise.withResolvers<void>(), resume: Promise.withResolvers<void>() };
  const fixture = (await compileFixture(dir))(async () => {
    gate.entered.resolve();
    await gate.resume.promise;
  });
  assert.throws(
    () => new Extensions({ providerPackages: [fixture, fixture] }),
    /Duplicate provider/,
  );
  assert.throws(
    () => new Extensions({ providerPackages: [{ ...fixture, apiMajor: 2 }] }),
    /Incompatible provider API/,
  );
  assert.throws(
    () => new Extensions({ providerPackages: [{ ...fixture, id: "other" }] }),
    /operation name/,
  );
  assert.throws(
    () =>
      new Extensions({
        providerPackages: [
          { ...fixture, operations: [...fixture.operations, ...fixture.operations] },
        ],
      }),
    /duplicate operation/,
  );
  const keys = testKeys();
  const start = async (withPackage: boolean) => {
    const { connections } = connectionsHarness(database.db, {
      keys,
      outbound: identity.outbound,
      clock: identity.clock,
      providerPackages: withPackage ? [fixture] : [],
    });
    const log = new Log(() => {});
    const app = await createApi({
      db: database.db,
      publicOrigin: SERVICE_ORIGIN,
      identity: identity.identity,
      connections,
      router: new NativeRouter({ connections, outbound: identity.outbound, log }),
      jobs: new JobService({
        db: database.db,
        connections,
        publicOrigin: SERVICE_ORIGIN,
        clock: identity.clock,
        log,
        limits: {
          inputBytes: 1024,
          resultBytes: 1024,
          runtimeSeconds: 3600,
          resultRetentionSeconds: 3600,
          recordRetentionSeconds: 3600,
        },
      }),
      events: undefined,
      log,
    });
    apiInstances.push(app);
    return app;
  };
  const one = await start(true),
    two = await start(true),
    missing = await start(false);
  const opCookie = await tableauSignIn(identity, tableau, operatorUser);
  const actor = await operatorSignIn(identity, opCookie.cookie);
  const operatorApp = await appSignIn(identity, opCookie.cookie);
  const viewerCookie = await tableauSignIn(identity, tableau, appUser);
  const viewer = await appSignIn(identity, viewerCookie.cookie);
  const alpha = (await listSites(database.db))[0]?.id as string;
  const beta = await addSite(database.db, "test", { deploymentId: DEPLOYMENT, contentUrl: "beta" });
  const preset = loadCatalog([
    {
      id: "fixture",
      name: "Fixture",
      description: "Data-only fixture provider",
      definition: {
        ownership: "shared",
        authentication: { method: "static" },
        apiHosts: [`${provider.origin}/api`],
        privateHosts: true,
      },
    },
  ])[0]?.definition;
  const binding = (label: string, enabled = true) => ({
    [operation]: { enabled, contractMajor: 1, options: { label } },
  });
  const call = (
    app: FastifyInstance,
    url: string,
    bearer: string,
    body?: object,
    method = body ? ("POST" as const) : ("GET" as const),
  ) => app.inject({ url, method, headers: auth(bearer), ...(body ? { payload: body } : {}) });
  const change = (
    app: FastifyInstance,
    id: string,
    payload: object,
    method: "PATCH" | "PUT" = "PATCH",
  ) => app.inject({ url: definitionHref(id), method, headers: auth(actor.bearer), payload });
  const create = (id: string, credential?: string, options: object = {}) =>
    call(one, "/v1/admin/definitions", actor.bearer, {
      ...preset,
      id,
      displayName: id,
      audience: [alpha],
      ...(credential ? { credential: { kind: "token", value: credential } } : {}),
      ...options,
    });
  for (const [id, owner, options] of [
    ["first", "synthetic-one", { operations: binding("one") }],
    ["second", "synthetic-two", { operations: binding("two") }],
    ["native", "synthetic-native", {}],
    ["hidden", "synthetic-hidden", { operations: binding("hidden"), audience: [beta.id] }],
  ] as const) {
    const response = await create(id, owner, options);
    assert.equal(response.statusCode, 201, response.body);
  }
  assert.equal(
    (
      await create("personal", undefined, {
        ownership: "personal",
        operations: binding("personal"),
      })
    ).statusCode,
    201,
  );
  const normalized = await create("normalized", "synthetic-normalized", {
    audience: [beta.id],
    operations: {
      [operation]: {
        enabled: true,
        contractMajor: 1,
        options: { label: "canonical", extra: "discarded" },
      },
    },
  });
  assert.deepEqual(normalized.json().definition.operations[operation].options, {
    label: "canonical",
  });
  const rejected = await create("bad", "synthetic-invalid", { operations: binding("") });
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.json().error.fields[0].path, `operations.${operation}.options.label`);

  const viewResponse = await call(one, "/v1/discovery", viewer.bearer);
  assert.equal(viewResponse.statusCode, 200, viewResponse.body);
  assert.equal(viewResponse.headers["cache-control"], "private, no-store");
  const view = viewResponse.json();
  assert.deepEqual(
    view.providers.map((p: { id: string }) => p.id),
    ["first", "native", "personal", "second"],
  );
  assert.equal(view.operator, undefined);
  assert.equal(view.providers[0].operations[0].contract.example.id, "example");
  assert.equal(view.providers[0].operations[0].state, "available");
  assert.equal(view.providers[0].operations[0].options, undefined);
  assert.equal(view.providers[2].operations[0].state, "connect_required");
  const appAdmin = await call(one, "/v1/discovery", operatorApp.bearer);
  assert.equal(appAdmin.json().operator, undefined);
  assert.equal((await call(one, "/v1/admin/definitions", viewer.bearer)).statusCode, 403);
  const opView = await call(one, "/v1/discovery", actor.bearer);
  assert.deepEqual(opView.json().operator.packages, [{ id: "fixture", version: "1.2.3" }]);
  assert.equal(opView.body.includes("synthetic-one"), false);
  assert.equal(viewResponse.body.includes("synthetic-one"), false);
  assert.equal(seen.length, 0);

  const invoke = (app: FastifyInstance, id: string, input: object = { id: "example" }) =>
    call(app, capabilityHref(id), viewer.bearer, { input });
  for (const id of ["first", "second"])
    assert.deepEqual((await invoke(one, id)).json(), { result: { found: true } });
  assert.deepEqual(seen, [
    { authorization: "Bearer synthetic-one", label: "one", service: undefined },
    { authorization: "Bearer synthetic-two", label: "two", service: undefined },
  ]);
  assert.deepEqual(
    await invoke(one, "hidden").then((r) => r.json()),
    await invoke(one, "native").then((r) => r.json()),
  );
  assert.equal((await invoke(one, "personal")).json().error.code, "not-connected");
  assert.equal(
    (
      await one.inject({
        url: "/v1/definitions/personal/credential",
        method: "PUT",
        headers: auth(viewer.bearer),
        payload: { credential: { kind: "token", value: "synthetic-personal" } },
      })
    ).statusCode,
    200,
  );
  assert.deepEqual((await invoke(one, "personal")).json(), { result: { found: true } });
  assert.equal(seen.at(-1)?.authorization, "Bearer synthetic-personal");
  assert.equal((await invoke(one, "first", {})).json().error.fields[0].path, "input.id");
  assert.equal(
    (await invoke(one, "first", { id: "x", host: "https://outside.example.invalid" })).json().error
      .upstream,
    "not-sent",
  );
  const badOutput = await invoke(one, "first", { id: "invalid" });
  assert.equal(badOutput.statusCode, 502);
  assert.equal(badOutput.json().error.upstream, "may-have-been-sent");
  const stream = await call(missing, "/v1/native/native/stream", viewer.bearer);
  assert.equal(stream.statusCode, 200);
  assert.equal(stream.body, "data: one\n\ndata: two\n\n");
  assert.equal((await invoke(missing, "first")).json().error.code, "capability-unavailable");
  const missingView = (await call(missing, "/v1/discovery", actor.bearer)).json();
  assert.equal(missingView.providers[0].operations[0].remediation.packageId, "fixture");
  assert.equal(
    (
      await call(one, capabilityHref("personal"), operatorApp.bearer, {
        input: { id: "example" },
      })
    ).json().error.code,
    "not-connected",
  );

  const current = async (id: string): Promise<DefinitionView> =>
    (await call(one, definitionHref(id), actor.bearer)).json().definition;
  const first = await current("first");
  const admitted = invoke(one, "first", { id: "admitted", wait: true });
  await gate.entered.promise;
  try {
    const detached = await change(missing, "first", {
      operations: binding("one", false),
      expectedVersion: first.version,
    });
    assert.equal(detached.statusCode, 200, detached.body);
    assert.equal((await invoke(two, "first")).statusCode, 404);
    assert.equal(
      (await change(two, "first", { operations: binding("other"), expectedVersion: first.version }))
        .statusCode,
      409,
    );
  } finally {
    gate.resume.resolve();
  }
  assert.deepEqual((await admitted).json(), { result: { found: true } });
  assert.equal(seen.at(-1)?.label, "one");

  gate = { entered: Promise.withResolvers<void>(), resume: Promise.withResolvers<void>() };
  const oldGeneration = invoke(two, "second", { id: "blocked", wait: true });
  await gate.entered.promise;
  const countBeforeRedefining = seen.length;
  try {
    const previous = await current("second");
    const redefined = await change(
      one,
      "second",
      {
        ...preset,
        id: "second",
        displayName: "second",
        audience: [alpha],
        expectedVersion: previous.version,
        credential: { kind: "token", value: "synthetic-replacement" },
      },
      "PUT",
    );
    assert.equal(redefined.statusCode, 200, redefined.body);
    assert.equal(redefined.json().definition.operations[operation].enabled, false);
    assert.equal((await invoke(one, "second")).statusCode, 404);
  } finally {
    gate.resume.resolve();
  }
  assert.equal((await oldGeneration).json().error.code, "definition-changed");
  assert.equal(seen.length, countBeforeRedefining);

  const remove = (await listOperators(database.db)).find(
    (entry) => entry.username === operatorUser.userName,
  );
  assert.ok(remove);
  await addOperator(database.db, "test", {
    deploymentId: DEPLOYMENT,
    siteContentUrl: "alpha",
    username: "backup@example.com",
  });
  await removeOperator(database.db, "test", remove.id);
  assert.equal((await call(one, "/v1/discovery", actor.bearer)).statusCode, 403);
  identity.clock.offsetMs = 8 * 86400 * 1000;
  assert.equal((await call(one, "/v1/discovery", viewer.bearer)).statusCode, 401);
  identity.clock.offsetMs = 0;
  await identity.identity.endSession(
    (await identity.identity.authenticate(viewer.bearer))?.sessionId as string,
  );
  assert.equal((await call(one, "/v1/discovery", viewer.bearer)).statusCode, 401);
  assert.equal(
    (
      await one.inject({
        url: "/v1/discovery",
        headers: { "tableau-service-authorization": "Basic bad" },
      })
    ).statusCode,
    401,
  );
});

test("direct service composition allocates enabled resources, isolates outages, and closes in host order", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tdas-service-composition-"));
  const database = await freshDatabase();
  const tableau = await new TableauStandIn().start();
  const identity = await identityHarness(database.db, tableau);
  const bootstrapPath = join(dir, "bootstrap.json");
  await writeFile(
    bootstrapPath,
    JSON.stringify({
      ...bootstrap,
      deployments: [{ id: DEPLOYMENT, kind: "tableau-cloud", podOrigin: tableau.origin }],
    }),
  );
  const loaded = load(
    {
      DATABASE_URL: database.url,
      DATABASE_CA_CERT: process.env.TDAS_TEST_PG_CA,
      SEALING_KEYS: sealingKeysEnv(testKeys()),
      BOOTSTRAP: bootstrapPath,
    },
    new Log(() => {}),
  );
  loaded.settings.port = 0;
  const servers: Running[] = [];
  t.after(async () => {
    await Promise.all(servers.map((server) => server.stop()));
    await identity.close();
    await tableau.close();
    await database.close();
    await rm(dir, { recursive: true, force: true });
  });
  let available = true;
  const lifecycle: string[] = [];
  const server = await runApi(loaded, [
    {
      id: "fixture",
      contractHref: "/v1/fixture/contract",
      open({ requireCaller }) {
        lifecycle.push("open");
        return {
          routes(scope) {
            scope.get("/v1/fixture/contract", async (request) => {
              await requireCaller(request);
              return { action: "/v1/fixture" };
            });
            scope.get("/v1/fixture", async (request) => {
              await requireCaller(request);
              if (!available)
                throw new ServiceError(503, "fixture-unavailable", "Fixture unavailable");
              return { fixture: true };
            });
          },
          discover: () =>
            available
              ? { state: "available", actions: [{ method: "GET", href: "/v1/fixture" }] }
              : { state: "unavailable", reason: "dependency-unavailable" },
          async close() {
            lifecycle.push("close");
          },
        };
      },
    },
    { id: "idle", contractHref: "/v1/idle/contract" },
  ]);
  servers.push(server);
  const omitted = await runApi(loaded);
  servers.push(omitted);
  const signedIn = await tableauSignIn(identity, tableau, operatorUser);
  const viewer = await appSignIn(identity, signedIn.cookie);
  const operator = await operatorSignIn(identity, signedIn.cookie);
  const request = (path: string, bearer?: string, port = server.port) =>
    fetch(`http://127.0.0.1:${port}${path}`, bearer ? { headers: auth(bearer) } : {});
  assert.deepEqual(lifecycle, ["open"]);
  const anonymous = await (await request("/v1/discovery")).json();
  assert.equal(anonymous.services, undefined);
  assert.equal(anonymous.providers, undefined);
  const archive = Buffer.from(await (await request(anonymous.cli.href)).arrayBuffer());
  assert.equal(archive.byteLength, anonymous.cli.bytes);
  assert.equal(createHash("sha256").update(archive).digest("hex"), anonymous.cli.sha256);
  for (const href of Object.values(anonymous.links) as string[])
    assert.equal((await request(href)).status, 200);
  assert.equal((await request("/v1/fixture")).status, 401);
  const view = await (await request("/v1/discovery", viewer.bearer)).json();
  assert.deepEqual(view.providers, []);
  assert.equal(view.services.length, 1);
  assert.equal((await request(view.services[0].contractHref, viewer.bearer)).status, 200);
  assert.deepEqual(await (await request(view.services[0].actions[0].href, viewer.bearer)).json(), {
    fixture: true,
  });
  const op = await (await request("/v1/discovery", operator.bearer)).json();
  assert.deepEqual(op.services[1], { id: "idle", state: "disabled" });
  available = false;
  assert.equal((await request("/v1/fixture", viewer.bearer)).status, 503);
  assert.equal(
    (await (await request("/v1/discovery", viewer.bearer)).json()).services[0].state,
    "unavailable",
  );
  assert.equal((await request("/v1/definitions", viewer.bearer)).status, 200);
  assert.equal((await request("/v1/fixture", viewer.bearer, omitted.port)).status, 404);
  assert.deepEqual(
    (await (await request("/v1/discovery", viewer.bearer, omitted.port)).json()).services,
    [],
  );
  await server.stop();
  assert.deepEqual(lifecycle, ["open", "close"]);
});
