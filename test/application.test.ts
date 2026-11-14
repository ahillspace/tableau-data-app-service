import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApplication } from "../src/application.js";
import {
  applicationConfigSchema,
  applyConfiguration,
  assertConfiguration,
} from "../src/application-config.js";
import { testPostgres } from "./postgres.js";

test("composed Slack application runs auth/proxy discovery with Jobs and Redis off, permits inert login initiation, and rejects silent deployment retargeting", async () => {
  const settings = applicationConfigSchema.parse(
    JSON.parse(await readFile(new URL("../service-config.example.json", import.meta.url), "utf8")),
  );
  const f = await testPostgres();
  let application: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    await applyConfiguration(f.db, settings);
    await applyConfiguration(f.db, settings);
    await assertConfiguration(f.db, settings, f.config);
    application = await createApplication(f.config, settings, {});
    assert.equal(application.jobs, undefined);
    assert.equal(await application.events.health(), "disabled");
    assert.equal((await application.app.inject({ url: "/health/ready" })).statusCode, 200);
    const initiated = await application.app.inject({
      method: "POST",
      url: "/v1/session/transactions",
      payload: {
        appId: "slack-example",
        deploymentId: "tableau-cloud",
        initiationVerifier: "a".repeat(64),
      },
    });
    assert.equal(initiated.statusCode, 201);
    assert.ok(initiated.json().id);
    assert.equal(
      (await application.app.inject({ url: "/v1/apps/slack-example/jobs" })).statusCode,
      404,
    );
    await f.db
      .insertInto("tableau_sites")
      .values({ id: "site-row", deployment_id: "tableau-cloud", site_id: "site", enabled: true })
      .execute();
    const identity = await application.sessions.access.createSession(
      {
        deploymentId: "tableau-cloud",
        siteId: "site",
        subjectId: "alice",
        verifiedAt: new Date(),
        adapterId: "tableau-cloud",
      },
      "slack-example",
    );
    const headers = { authorization: `Bearer ${identity.token}` };
    const providers = await application.app.inject({
      url: "/v1/apps/slack-example/providers",
      headers,
    });
    assert.equal(providers.statusCode, 200);
    assert.equal(providers.json().events, undefined);
    assert.deepEqual(providers.json().items[0].setupModes, ["static"]);
    assert.deepEqual(
      (
        await application.app.inject({ url: "/v1/apps/slack-example/capabilities", headers })
      ).json(),
      { items: [] },
    );
    const retargeted = structuredClone(settings);
    const deployment = retargeted.deployments[0];
    assert.ok(deployment?.kind === "cloud");
    deployment.podOrigin = "https://another.online.tableau.com";
    await assert.rejects(applyConfiguration(f.db, retargeted), /continuity/);
    await assert.rejects(assertConfiguration(f.db, retargeted, f.config), /differs/);
    const missing = structuredClone(settings);
    missing.apps.push({ ...missing.apps[0]!, id: "missing" });
    await assert.rejects(assertConfiguration(f.db, missing, f.config), /differs/);
  } finally {
    await application?.close();
    await f.close();
  }
});

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

test("compiled API and supervised worker start independently, expose separate readiness and drain on SIGTERM", async () => {
  execFileSync(
    fileURLToPath(new URL("../node_modules/.bin/tsc", import.meta.url)),
    ["-p", "tsconfig.build.json"],
    { cwd: new URL("..", import.meta.url), stdio: "pipe" },
  );
  const f = await testPostgres();
  const directory = await mkdtemp(join(tmpdir(), "tableau-processes-"));
  const port = await freePort(),
    workerPort = await freePort();
  const configFile = join(directory, "config.json");
  await writeFile(
    configFile,
    await readFile(new URL("../service-config.example.json", import.meta.url)),
  );
  const env = {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: f.config.DATABASE_URL,
    SERVICE_ORIGIN: `http://127.0.0.1:${port}`,
    PORT: String(port),
    WORKER_HEALTH_PORT: String(workerPort),
    HOST: "127.0.0.1",
    ENCRYPTION_ACTIVE_KEY_ID: "test",
    ENCRYPTION_KEYS: JSON.stringify({ test: "01".repeat(32) }),
    SERVICE_CONFIG_FILE: configFile,
  };
  const children: ReturnType<typeof spawn>[] = [];
  const exits: Promise<unknown>[] = [];
  try {
    execFileSync(process.execPath, ["dist/config-command.js"], {
      cwd: new URL("..", import.meta.url),
      env,
      stdio: "pipe",
    });
    for (const role of ["api", "worker"]) {
      const child = spawn(process.execPath, [`dist/${role}.js`], {
        cwd: new URL("..", import.meta.url),
        env,
        stdio: "pipe",
      });
      children.push(child);
      exits.push(once(child, "exit"));
      let errors = "";
      child.stderr!.on("data", (data) => {
        errors += data.toString();
      });
      const origin = `http://127.0.0.1:${role === "api" ? port : workerPort}`;
      const deadline = Date.now() + 10000;
      let ready: Response | undefined;
      while (Date.now() < deadline && child.exitCode === null) {
        try {
          const response = await fetch(`${origin}/health/ready`);
          if (response.ok) {
            ready = response;
            break;
          }
          await response.body?.cancel();
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(ready, `${role} did not become ready: ${errors}`);
      const status = (await ready.json()) as { jobs?: string; sources?: string };
      if (role === "worker") {
        assert.equal(status.jobs, "disabled");
        assert.equal(status.sources, "disabled");
        assert.equal((await fetch(`${origin}/v1/session/transactions`)).status, 404);
      }
      assert.equal((await fetch(`${origin}/health/live`)).status, 200);
    }
    children[1]!.kill("SIGTERM");
    assert.deepEqual(await exits[1], [0, null]);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health/ready`)).status, 200);
    children[0]!.kill("SIGTERM");
    assert.deepEqual(await exits[0], [0, null]);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.all(exits);
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
