import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { createApplication, type InstalledDeclarations } from "../src/application.js";
import { applyConfiguration, readApplicationConfig } from "../src/application-config.js";
import type { ProviderContext } from "../src/core-ports.js";
import { JobsWorker } from "../src/jobs/worker.js";
import { testPostgres } from "./postgres.js";

test("configured installed provider supports ordinary HTTP and an explicit Job in independent API and worker applications", async () => {
  const f = await testPostgres();
  const directory = await mkdtemp(join(tmpdir(), "tableau-installed-provider-"));
  let calls = 0;
  const upstream = createServer(async (request, response) => {
    calls++;
    assert.equal(request.url, "/api/echo");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader("content-type", "application/json");
    response.end(Buffer.concat(chunks));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing upstream port");
  const schema = z.strictObject({ value: z.string() });
  const ref = { id: "configured-echo", version: 1 };
  const perform = async (input: unknown, context: ProviderContext) => {
    const response = await context.request({
      endpoint: "api",
      method: "POST",
      path: "/echo",
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify(input),
    });
    return response.json();
  };
  const installed: InstalledDeclarations = {
    providers: [
      {
        id: "echo",
        revision: 7,
        mode: "none",
        credentialsSchema: z.strictObject({}),
        contextSchema: z.strictObject({}),
        endpoints: {
          api: {
            baseUrl: `http://127.0.0.1:${address.port}/api`,
            allowHttp: true,
            privateCidrs: ["127.0.0.1/32"],
          },
        },
        attach: () => new Headers(),
        capabilities: [
          {
            ref,
            providerRegistrationId: "echo",
            http: {
              input: { kind: "json", schema },
              response: { kind: "json", schema },
              handler: perform,
            },
            job: { inputSchema: schema, resultSchema: schema },
          },
        ],
      },
    ],
    jobs: [
      {
        ref,
        providerRegistrationId: "echo",
        inputSchema: schema,
        resultSchema: schema,
        handler: async (input, context) => ({
          kind: "complete",
          result: await perform(input, context),
        }),
      },
    ],
    events: new Map(),
  };
  const raw = JSON.parse(
    await readFile(new URL("../service-config.example.json", import.meta.url), "utf8"),
  );
  raw.providers = [{ id: "echo", revision: 7, enabled: true, mode: "none", reauthSeconds: null }];
  const configFile = join(directory, "service.json");
  await writeFile(configFile, JSON.stringify(raw));
  const settings = await readApplicationConfig({ SERVICE_CONFIG_FILE: configFile });
  let api: Awaited<ReturnType<typeof createApplication>> | undefined;
  let workerApplication: Awaited<ReturnType<typeof createApplication>> | undefined;
  let worker: JobsWorker | undefined;
  try {
    await assert.rejects(applyConfiguration(f.db, settings), /trusted installed declaration/);
    assert.equal(
      (await f.db.selectFrom("provider_registrations").selectAll().execute()).length,
      0,
      "uninstalled configuration fails before any publication",
    );
    await applyConfiguration(f.db, settings, installed);
    await applyConfiguration(f.db, settings, installed);
    const row = await f.db
      .selectFrom("provider_registrations")
      .selectAll()
      .where("id", "=", "echo")
      .executeTakeFirstOrThrow();
    assert.equal(row.config_revision, 7);
    assert.equal(row.mode, "none");
    api = await createApplication(f.config, settings, {}, installed);
    await api.app.listen({ host: "127.0.0.1", port: 0 });
    await f.db
      .insertInto("tableau_sites")
      .values({ id: "site-row", deployment_id: "tableau-cloud", site_id: "site", enabled: true })
      .execute();
    const session = await api.sessions.access.createSession(
      {
        deploymentId: "tableau-cloud",
        siteId: "site",
        subjectId: "alice",
        verifiedAt: new Date(),
        adapterId: "tableau-cloud",
      },
      "slack-example",
    );
    const headers = {
      authorization: `Bearer ${session.token}`,
      "content-type": "application/json",
    };
    const base = `${api.app.listeningOrigin}/v1/apps/slack-example`;
    const discovery = (await (await fetch(`${base}/providers`, { headers })).json()) as {
      items: { id: string }[];
    };
    assert.deepEqual(discovery.items.map((item) => item.id).sort(), ["echo", "slack"]);
    assert.deepEqual(api.providers.get("slack").capabilities, []);
    const ordinary = await fetch(`${base}/capabilities/${ref.id}/versions/1/invoke`, {
      method: "POST",
      headers,
      body: JSON.stringify({ value: "ordinary" }),
    });
    assert.equal(ordinary.status, 200);
    assert.deepEqual(await ordinary.json(), { value: "ordinary" });
    assert.equal((await api.jobs!.db.selectFrom("jobs").select("id").execute()).length, 0);
    assert.equal(calls, 1);
    const admitted = await fetch(`${base}/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        submissionId: "configured-job",
        capability: ref,
        input: { value: "background" },
      }),
    });
    assert.equal(admitted.status, 202);
    const job = (await admitted.json()) as { id: string };
    const independentSettings = await readApplicationConfig({ SERVICE_CONFIG_FILE: configFile });
    workerApplication = await createApplication(f.config, independentSettings, {}, installed);
    assert.notEqual(workerApplication.core.db, api.core.db);
    worker = new JobsWorker(workerApplication.jobs!, {
      ...independentSettings.worker,
      cleanupMs: independentSettings.maintenance.cleanupMs,
      requestTermination: (reason) => {
        throw new Error(reason);
      },
    });
    await worker.start();
    const deadline = Date.now() + 8000;
    let state = "";
    while (Date.now() < deadline) {
      const view = (await (await fetch(`${base}/jobs/${job.id}`, { headers })).json()) as {
        state: string;
      };
      state = view.state;
      if (state === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(state, "succeeded");
    const result = await fetch(`${base}/jobs/${job.id}/result`, { headers });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { value: "background" });
    assert.equal(calls, 2);
    assert.equal(worker.readiness, true);
    const incompatible = structuredClone(settings);
    incompatible.providers[0]!.revision++;
    await assert.rejects(
      createApplication(f.config, incompatible, {}, installed),
      /trusted installed declaration/,
    );
    await f.db
      .updateTable("provider_registrations")
      .set({ reauth_seconds: 60 })
      .where("id", "=", "echo")
      .execute();
    await assert.rejects(createApplication(f.config, settings, {}, installed), /differs/);
  } finally {
    await worker?.close();
    await workerApplication?.close();
    await api?.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
