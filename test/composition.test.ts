import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { MetricsView, StatusView } from "../src/contracts/operator.ts";
import { openDatabase } from "../src/persistence/database.ts";
import { caCert, freshDatabaseUrl, sealingKeysEnv, testKeys } from "./support/db.ts";
import { standIn } from "./support/https.ts";
import { appSignIn, identityHarness, operatorSignIn, tableauSignIn } from "./support/identity.ts";
import { TableauStandIn } from "./support/tableau.ts";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;
async function port() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const value = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return value;
}
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 20000;
  while (!(await check())) {
    if (Date.now() >= deadline) assert.fail(label);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("actual API replicas and worker compose with CLI-shaped secrets, native/SSE, merged metrics and fresh instance identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tdas-composition-"));
  const tableau = await new TableauStandIn().start();
  const provider = await standIn((request, response) => {
    if (request.headers.authorization !== "Bearer synthetic-composition-token") {
      response.writeHead(401).end();
      return;
    }
    if (request.url === "/stream") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"text":"one"}\n\n');
      setTimeout(() => response.end('data: {"text":"two"}\n\n'), 25);
    } else {
      response.writeHead(207, { "content-type": "application/json" });
      response.end('{"normal":true}');
    }
  }, "127.0.0.1");
  const url = await freshDatabaseUrl(),
    keys = testKeys(),
    apiPort = await port(),
    replicaPort = await port(),
    workerPort = await port();
  const bootstrap = join(directory, "bootstrap.json");
  await writeFile(
    bootstrap,
    JSON.stringify({
      publicOrigin: "https://service.test",
      deployments: [{ id: "cloud-test", kind: "tableau-cloud", podOrigin: tableau.origin }],
      firstSite: { deploymentId: "cloud-test", contentUrl: "alpha" },
      firstOperator: {
        deploymentId: "cloud-test",
        siteContentUrl: "alpha",
        username: "op@example.com",
      },
    }),
  );
  const env = {
    PATH: process.env.PATH ?? "",
    DATABASE_URL: url,
    DATABASE_CA_CERT: process.env.TDAS_TEST_PG_CA as string,
    NODE_EXTRA_CA_CERTS: process.env.TDAS_TEST_PG_CA as string,
    SEALING_KEYS: sealingKeysEnv(keys),
    BOOTSTRAP: bootstrap,
    PORT: String(apiPort),
    WORKER_HEALTH_PORT: String(workerPort),
  };
  const children: {
    child: ReturnType<typeof spawn>;
    exited: Promise<number | null>;
    output: () => string;
  }[] = [];
  const start = (role: string, overrides: Record<string, string> = {}) => {
    const child = spawn(process.execPath, [MAIN, role], {
      env: { ...env, ...overrides },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (data) => (output += data));
    child.stderr?.on("data", (data) => (output += data));
    const result = {
      child,
      output: () => output,
      exited: new Promise<number | null>((resolve) => child.once("exit", resolve)),
    };
    children.push(result);
    return result;
  };
  let database: ReturnType<typeof openDatabase> | undefined;
  let identity: Awaited<ReturnType<typeof identityHarness>> | undefined;
  try {
    const migrated = start("migrate");
    assert.equal(await migrated.exited, 0, migrated.output());
    const one = start("api"),
      two = start("api", { PORT: String(replicaPort) }),
      worker = start("worker");
    for (const endpoint of [apiPort, replicaPort, workerPort])
      await until(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${endpoint}/health/ready`)).status === 200;
        } catch {
          return false;
        }
      }, "production role did not become ready");
    database = openDatabase({ url, caCert: caCert(), applicationName: "composition-observer" });
    identity = await identityHarness(database.db, tableau);
    const signIn = await tableauSignIn(identity, tableau, {
      siteId: "site-a",
      siteContentUrl: "alpha",
      userId: "user-op",
      userName: "op@example.com",
    });
    const operator = await operatorSignIn(identity, signIn.cookie),
      app = await appSignIn(identity, signIn.cookie, "composition-app");
    const site = await database.db
      .selectFrom("trusted_sites")
      .select("id")
      .executeTakeFirstOrThrow();
    const admin = (path: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${apiPort}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Tableau-Service-Authorization": `Bearer ${operator.bearer}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const created = await admin("/v1/admin/definitions", {
      id: "composition",
      displayName: "Composition",
      ownership: "shared",
      apiHosts: [provider.origin],
      authentication: { method: "static" },
      audience: [site.id],
      privateHosts: true,
      credential: { kind: "token", value: "synthetic-composition-token" },
    });
    assert.equal(created.status, 201, await created.clone().text());
    for (const [endpoint, path] of [
      [apiPort, "/normal"],
      [replicaPort, "/stream"],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${endpoint}/v1/native/composition${path}`, {
        headers: { "Tableau-Service-Authorization": `Bearer ${app.bearer}` },
      });
      assert.equal(response.status, path === "/stream" ? 200 : 207, await response.clone().text());
      const payload = await response.text();
      assert.match(payload, path === "/stream" ? /data:.*one[\s\S]*data:.*two/ : /"normal":true/);
    }
    await until(async () => {
      const view = (await (await admin("/v1/admin/status")).json()) as StatusView;
      return (
        view.processes.filter((p) => p.role === "api" && p.state === "ok").length === 2 &&
        view.processes.some((p) => p.role === "worker" && p.state === "ok")
      );
    }, "both APIs and the worker must publish independent fresh identities");
    const status = (await (await admin("/v1/admin/status")).json()) as StatusView;
    assert.equal(new Set(status.processes.map((p) => p.instanceId)).size, 3);
    assert.equal(status.events.state, "disabled");
    assert.equal(status.readiness.value?.ready, true);
    assert.equal(status.activity.value?.activeApps, 1);
    assert.ok((status.activity.value?.activeSessions ?? 0) >= 2);
    await until(
      async () =>
        Number(
          (
            await database?.db
              .selectFrom("metric_snapshots")
              .select(({ fn }) => fn.sum<string>("requests").as("n"))
              .where("definition_id", "=", "composition")
              .executeTakeFirst()
          )?.n ?? 0,
        ) === 2,
      "ten-second role flush must persist both replica snapshots",
    );
    const stored = await database.db
      .selectFrom("metric_snapshots")
      .selectAll()
      .where("definition_id", "=", "composition")
      .execute();
    assert.equal(stored.length, 2);
    assert.equal(new Set(stored.map((s) => s.instance_id)).size, 2);
    assert.equal(
      stored.reduce((n, row) => n + row.upstream_histogram.reduce((a, b) => a + Number(b), 0), 0),
      2,
    );
    const from = Math.min(...stored.map((row) => row.minute.getTime())),
      to = Math.max(...stored.map((row) => row.minute.getTime())) + 60000;
    // Allow the actual observed minute to close; no fixture timestamp or saved histogram is rewritten.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, to - Date.now()) + 25));
    const range = new URLSearchParams({
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      definition: "composition",
    });
    const metricsResponse = await admin(`/v1/admin/metrics?${range}`);
    assert.equal(metricsResponse.status, 200, await metricsResponse.clone().text());
    const metricView = (await metricsResponse.json()) as MetricsView;
    assert.equal(metricView.totals.requests, 2);
    assert.equal(metricView.totals.errors, 0);
    assert.equal(metricView.totals.upstreamSamples, 2);
    assert.ok(metricView.totals.upstreamP50Ms !== null);
    assert.ok(metricView.totals.upstreamP95Ms !== null);
    assert.equal(
      metricView.series.reduce((n, row) => n + row.requests, 0),
      2,
    );
    const audit = await (
      await admin("/v1/admin/audit?definition=composition&action=definition.create")
    ).json();
    assert.equal(audit.entries.length, 1);
    assert.equal(audit.entries[0].subject, "composition");
    for (const run of [one, two, worker]) {
      run.child.kill("SIGTERM");
      assert.equal(await run.exited, 0, run.output());
    }
    const allOutput = children.map((child) => child.output()).join("\n");
    assert.equal(allOutput.includes("synthetic-composition-token"), false);
  } finally {
    for (const run of children) if (run.child.exitCode === null) run.child.kill("SIGKILL");
    await Promise.all(children.map((run) => run.exited));
    await identity?.close();
    await database?.db.destroy();
    await tableau.close();
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});
