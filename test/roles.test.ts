/**
 * The service's processes as a host runs them: `node src/main.ts migrate|api|worker` with real
 * settings, then the host-local admin commands against the same database.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { ADMIN_ACTOR, admin } from "../src/admin/bin.ts";
import { listOperators } from "../src/identity/directory.ts";
import { openDatabase } from "../src/persistence/database.ts";
import { caCert, freshDatabaseUrl, sealingKeysEnv, testKeys } from "./support/db.ts";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

type Run = { child: ChildProcess; output: () => string; exited: Promise<number | null> };

function start(role: string, env: Record<string, string>): Run {
  const child = spawn(process.execPath, [MAIN, role], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  return { child, output: () => output, exited };
}

async function until(
  check: () => Promise<boolean> | boolean,
  what: string,
  ms = 15_000,
): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function status(
  url: string,
): Promise<{ status: number; body: Record<string, unknown> } | undefined> {
  try {
    const response = await fetch(url);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

describe("roles", () => {
  let env: Record<string, string>;
  const running: Run[] = [];

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdas-roles-"));
    const bootstrap = join(dir, "bootstrap.json");
    writeFileSync(
      bootstrap,
      JSON.stringify({
        deployments: [
          {
            id: "cloud-test",
            kind: "tableau-cloud",
            podOrigin: "https://tableau.example",
            clientId: "client",
          },
        ],
        firstSite: { deploymentId: "cloud-test", contentUrl: "alpha" },
        firstOperator: {
          deploymentId: "cloud-test",
          siteContentUrl: "alpha",
          username: "op@example.com",
        },
        publicOrigin: "https://service.test",
      }),
    );
    env = {
      DATABASE_URL: await freshDatabaseUrl(),
      DATABASE_CA_CERT: process.env.TDAS_TEST_PG_CA as string,
      SEALING_KEYS: sealingKeysEnv(testKeys()),
      BOOTSTRAP: bootstrap,
      PORT: String(await freePort()),
      WORKER_HEALTH_PORT: String(await freePort()),
      REDIS_URL: process.env.TDAS_TEST_REDIS as string,
    };
  });
  after(async () => {
    for (const run of running) run.child.kill("SIGKILL");
  });

  test("api and worker refuse to start before migrate, which then brings the schema current", async () => {
    for (const role of ["api", "worker"]) {
      const refused = start(role, env);
      assert.equal(await refused.exited, 1);
      assert.match(refused.output(), /"errorCode":"schema-behind"/);
    }
    const migrate = start("migrate", env);
    assert.equal(await migrate.exited, 0, migrate.output());
    assert.match(migrate.output(), /migrations complete/);
    const again = start("migrate", env);
    assert.equal(await again.exited, 0);
  });

  test("the api role serves health with the database, schema and events checked, and stops on SIGTERM", async () => {
    const api = start("api", env);
    running.push(api);
    const ready = `http://127.0.0.1:${env.PORT}/health/ready`;
    await until(async () => (await status(ready))?.status === 200, `api ready\n${api.output()}`);
    const body = (await status(ready))?.body as { checks: Record<string, unknown> };
    assert.deepEqual(Object.keys(body.checks).sort(), ["database", "events", "schema"]);
    assert.equal((await status(`http://127.0.0.1:${env.PORT}/health/live`))?.status, 200);
    api.child.kill("SIGTERM");
    assert.equal(await api.exited, 0, api.output());
    assert.match(api.output(), /stopping/);
  });

  test("the worker role runs maintenance and reports ready on its own port", async () => {
    const worker = start("worker", env);
    running.push(worker);
    const ready = `http://127.0.0.1:${env.WORKER_HEALTH_PORT}/health/ready`;
    await until(
      async () => (await status(ready))?.status === 200,
      `worker ready\n${worker.output()}`,
    );
    worker.child.kill("SIGTERM");
    assert.equal(await worker.exited, 0, worker.output());
  });

  test("V1 V26 a startup failure lists the bad fields and never their values", async () => {
    const secret = randomBytes(20).toString("base64");
    const bad = start("api", {
      ...env,
      SEALING_KEYS: JSON.stringify({ current: "k1", keys: { k1: secret } }),
      PORT: "not-a-port",
    });
    assert.equal(await bad.exited, 1);
    const output = bad.output();
    assert.match(output, /"errorCode":"invalid-settings"/);
    assert.match(output, /SEALING_KEYS/);
    assert.match(output, /PORT/);
    assert.ok(!output.includes(secret), "the sealing key value is not printed");
    const unknown = start("serve", env);
    assert.equal(await unknown.exited, 2);
  });

  test("tdas-admin adds an operator without a sign-in and reseals online", async () => {
    const lines: string[] = [];
    const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
    assert.equal(
      await admin(
        [
          "operators",
          "add",
          "--deployment",
          "cloud-test",
          "--site",
          "alpha",
          "--user",
          "rescue@example.com",
        ],
        env,
        io,
      ),
      0,
      lines.join("\n"),
    );
    const { db } = openDatabase({
      url: env.DATABASE_URL as string,
      caCert: caCert(),
      applicationName: "tdas-test",
    });
    try {
      const names = (await listOperators(db)).map((o) => o.username);
      assert.ok(names.includes("rescue@example.com"));
      const audit = await db
        .selectFrom("audit")
        .selectAll()
        .where("actor", "=", ADMIN_ACTOR)
        .execute();
      assert.equal(audit.length, 1);
    } finally {
      await db.destroy();
    }
    lines.length = 0;
    assert.equal(
      await admin(
        ["operators", "add", "--deployment", "nowhere", "--site", "alpha", "--user", "x"],
        env,
        io,
      ),
      1,
    );
    assert.match(lines.join("\n"), /known-deployment/);
    lines.length = 0;
    assert.equal(await admin(["reseal"], env, io), 0);
    assert.deepEqual(JSON.parse(lines[0] as string), { resealed: 0, remaining: 0 });
    assert.equal(await admin(["operators"], env, io), 2);
  });
});
