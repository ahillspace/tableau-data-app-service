import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApi } from "../../src/http/app.ts";
import { JobService } from "../../src/jobs/service.ts";
import { Metrics } from "../../src/operations/metrics.ts";
import { Operations } from "../../src/operations/status.ts";
import { openDatabase } from "../../src/persistence/database.ts";
import { Log } from "../../src/platform/log.ts";
import { NativeRouter } from "../../src/router/router.ts";
import { connectionsHarness } from "./connections.ts";
import { caCert, freshDatabase, testKeys } from "./db.ts";
import { appSignIn, identityHarness, operatorSignIn, tableauSignIn } from "./identity.ts";
import { TableauStandIn } from "./tableau.ts";

/** Actual listening API replicas, independent pools, shared schema and synthetic signed identity. */
export async function intakeFixture(consoleEnabled = false) {
  const database = await freshDatabase(),
    tableau = await new TableauStandIn().start();
  const keys = testKeys(),
    lines: string[] = [],
    log = new Log((line) => lines.push(line));
  const opened: { stop(): Promise<void> }[] = [];
  const replica = async () => {
    const { db } = openDatabase({
      url: database.url,
      caCert: caCert(),
      applicationName: "tdas-intake-replica",
    });
    const h = await identityHarness(db, tableau);
    const c = connectionsHarness(db, { keys, outbound: h.outbound, clock: h.clock });
    const instanceId = randomUUID(),
      metrics = new Metrics({ db, instanceId, clock: h.clock, log });
    const operations = new Operations({
      db,
      instanceId,
      role: "api",
      startedAt: h.clock.now(),
      clock: h.clock,
      log,
      metrics,
      eventsEnabled: false,
      eventsReady: () => false,
      version: "synthetic",
    });
    const jobs = new JobService({
      db,
      connections: c.connections,
      publicOrigin: "https://service.test",
      clock: h.clock,
      log,
      limits: {
        inputBytes: 4096,
        resultBytes: 4096,
        runtimeSeconds: 3600,
        resultRetentionSeconds: 86400,
        recordRetentionSeconds: 86400,
      },
    });
    const api = await createApi({
      db,
      publicOrigin: "https://service.test",
      identity: h.identity,
      connections: c.connections,
      router: new NativeRouter({ connections: c.connections, outbound: h.outbound, log, metrics }),
      jobs,
      events: undefined,
      log,
      consoleEnabled,
      metrics,
      operations,
    });
    await api.listen({ port: 0, host: "127.0.0.1" });
    const origin = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
    const stop = async () => {
      await api.close();
      await h.close();
      await db.destroy();
    };
    opened.push({ stop });
    return { db, h, c, api, origin, metrics, operations, instanceId };
  };
  const first = await replica();
  const operator = await tableauSignIn(first.h, tableau, {
    siteId: "site-a",
    siteContentUrl: "alpha",
    userId: "user-op",
    userName: "op@example.com",
  });
  const grant = await operatorSignIn(first.h, operator.cookie);
  const app = await appSignIn(first.h, operator.cookie);
  const site = await database.db.selectFrom("trusted_sites").select("id").executeTakeFirstOrThrow();
  const call = (
    path: string,
    options: {
      method?: string;
      body?: unknown;
      bearer?: string;
      origin?: string;
      headers?: Record<string, string>;
    } = {},
  ) =>
    fetch(`${options.origin ?? first.origin}${path}`, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers: {
        "Tableau-Service-Authorization": `Bearer ${options.bearer ?? grant.bearer}`,
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      redirect: "manual",
    });
  return {
    ...first,
    first,
    replica,
    tableau,
    siteId: site.id,
    operator,
    grant,
    app,
    call,
    lines,
    keys,
    close: async () => {
      for (const resource of opened.reverse()) await resource.stop();
      await tableau.close();
      await database.close();
    },
  };
}
