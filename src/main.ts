/**
 * The service's one entry point: `migrate`, `api` or `worker`. Each role loads and validates every
 * setting before doing anything, and refuses to serve against a schema that is behind.
 */

import { randomUUID } from "node:crypto";
import { DefinitionStore } from "./connections/definitions.ts";
import { ConnectionService } from "./connections/service.ts";
import { createEvents } from "./events/index.ts";
import { createApi } from "./http/app.ts";
import { applyBootstrap } from "./identity/directory.ts";
import { IdentityService } from "./identity/sessions.ts";
import {
  type DeploymentAdapter,
  TableauCloudAdapter,
  tableauClientMetadata,
} from "./identity/tableau-cloud.ts";
import { JobService } from "./jobs/service.ts";
import type { JobLimits } from "./jobs/types.ts";
import { JobWorker } from "./jobs/worker.ts";
import { Metrics } from "./operations/metrics.ts";
import { Operations } from "./operations/status.ts";
import { assertSchemaCurrent, type Db, migrate, openDatabase } from "./persistence/database.ts";
import { type Bootstrap, loadBootstrap } from "./platform/bootstrap.ts";
import { systemClock } from "./platform/clock.ts";
import { ServiceError } from "./platform/errors.ts";
import { Log } from "./platform/log.ts";
import { Outbound } from "./platform/outbound.ts";
import {
  type Installation,
  loadSettings,
  resolveInstallation,
  type Settings,
} from "./platform/settings.ts";
import { installedExtensions } from "./presets/index.ts";
import { NativeRouter } from "./router/router.ts";
import { Sealer } from "./sealing/sealer.ts";
import { Maintenance } from "./worker/maintenance.ts";
import { WorkerRole } from "./worker/role.ts";

type Role = "migrate" | "api" | "worker";

/** What a role has opened, closed in reverse order on shutdown or when startup fails part-way. */
class Resources {
  readonly #closers: (() => Promise<void>)[] = [];
  add<T>(value: T, close: (value: T) => Promise<void>): T {
    this.#closers.push(() => close(value));
    return value;
  }
  async close(): Promise<void> {
    for (const close of this.#closers.splice(0).reverse()) await close();
  }
  /** Runs startup; when it fails, whatever it opened is closed before the error propagates. */
  async starting<T>(start: () => Promise<T>): Promise<T> {
    try {
      return await start();
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }
}
const ROLES: readonly Role[] = ["migrate", "api", "worker"];

export type Loaded = {
  settings: Settings;
  bootstrap: Bootstrap;
  installation: Installation;
  log: Log;
};

/** Settings, bootstrap and the values they share, with every secret registered with the log. */
export function load(
  env: Record<string, string | undefined> = process.env,
  log = new Log(),
): Loaded {
  const settings = loadSettings(env);
  for (const key of settings.sealingKeys.keys.values()) log.protect(key.toString("base64"));
  log.protect(new URL(settings.databaseUrl).password || undefined);
  if (settings.redisUrl) log.protect(new URL(settings.redisUrl).password || undefined);
  const bootstrap = loadBootstrap(settings.bootstrapPath);
  return { settings, bootstrap, installation: resolveInstallation(settings, bootstrap), log };
}

export function jobLimits(settings: Settings): JobLimits {
  return {
    inputBytes: settings.jobInputCap,
    resultBytes: settings.jobResultCap,
    runtimeSeconds: settings.jobRuntimeCapSeconds,
    resultRetentionSeconds: settings.jobResultRetentionSeconds,
    recordRetentionSeconds: settings.jobRecordRetentionSeconds,
  };
}

function database(settings: Settings, role: Role, resources: Resources): Db {
  const { db } = openDatabase({
    url: settings.databaseUrl,
    caCert: settings.databaseCaCert,
    applicationName: `tdas-${role}`,
  });
  return resources.add(db, (d) => d.destroy());
}

function outbound(settings: Settings, resources: Resources): Outbound {
  const out = new Outbound({
    connectTimeoutMs: settings.upstreamConnectTimeoutMs,
    headersTimeoutMs: settings.upstreamHeadersTimeoutMs,
    idleTimeoutMs: settings.upstreamIdleTimeoutMs,
  });
  return resources.add(out, (o) => o.close());
}

/** The connections component both serving roles share. */
function connectionsFor(
  db: Db,
  settings: Settings,
  installation: Installation,
  out: Outbound,
  log: Log,
  metrics: Metrics,
): ConnectionService {
  const sealer = new Sealer(settings.sealingKeys);
  const definitions = new DefinitionStore({
    db,
    extensions: installedExtensions(),
    sealer,
    clock: systemClock,
  });
  return new ConnectionService({
    db,
    definitions,
    sealer,
    outbound: out,
    publicOrigin: installation.publicOrigin,
    clock: systemClock,
    log: log.child({ component: "connections" }),
    metrics,
  });
}

function adapters(
  bootstrap: Bootstrap,
  publicOrigin: string,
  out: Outbound,
): Map<string, DeploymentAdapter> {
  // Tableau's sign-in and REST hosts are public, so private addresses are refused.
  const fetch = out.fetcher(false);
  return new Map(
    bootstrap.deployments.map((d) => [
      d.id,
      new TableauCloudAdapter({
        deploymentId: d.id,
        podOrigin: d.podOrigin,
        clientId: tableauClientMetadata(publicOrigin).client_id,
        fetch,
      }) as DeploymentAdapter,
    ]),
  );
}

/** Runs until SIGTERM or SIGINT, then stops in order. A second signal exits at once. */
function onShutdown(log: Log, stop: () => Promise<void>): void {
  let stopping = false;
  const handle = (signal: string) => {
    if (stopping) process.exit(1);
    stopping = true;
    log.info("stopping", { signal });
    stop().then(
      () => process.exit(0),
      (error: unknown) => {
        log.error("stop failed", { error });
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => handle("SIGTERM"));
  process.on("SIGINT", () => handle("SIGINT"));
}

export async function runMigrate(loaded: Loaded): Promise<void> {
  const { settings, log } = loaded;
  const resources = new Resources();
  try {
    const applied = await migrate(database(settings, "migrate", resources));
    log.info("migrations complete", { applied });
  } finally {
    await resources.close();
  }
}

function startTelemetry(metrics: Metrics, operations: Operations, resources: Resources): void {
  const flush = setInterval(() => void metrics.flush(), 10_000);
  const heartbeat = setInterval(() => void operations.heartbeat(), 15_000);
  flush.unref();
  heartbeat.unref();
  void operations.heartbeat();
  resources.add({ flush, heartbeat }, async (timers) => {
    clearInterval(timers.flush);
    clearInterval(timers.heartbeat);
    await metrics.flush();
    await operations.heartbeat();
  });
}

export type Running = { port: number; stop: () => Promise<void> };

export async function runApi(loaded: Loaded): Promise<Running> {
  const resources = new Resources();
  return await resources.starting(() => startApi(loaded, resources));
}

async function startApi(loaded: Loaded, resources: Resources): Promise<Running> {
  const { settings, bootstrap, installation, log } = loaded;
  const db = database(settings, "api", resources);
  await assertSchemaCurrent(db);
  await applyBootstrap(db, bootstrap, log);
  const out = outbound(settings, resources);
  const instanceId = randomUUID(),
    startedAt = new Date();
  const metrics = new Metrics({ db, instanceId, log });
  const connections = connectionsFor(db, settings, installation, out, log, metrics);
  const identity = new IdentityService({
    db,
    adapters: adapters(bootstrap, installation.publicOrigin, out),
    publicOrigin: installation.publicOrigin,
    signInLimitSeconds: installation.signInLimitSeconds,
    clock: systemClock,
    log: log.child({ component: "identity" }),
  });
  const jobs = new JobService({
    db,
    connections,
    limits: jobLimits(settings),
    publicOrigin: installation.publicOrigin,
    clock: systemClock,
    log: log.child({ component: "jobs" }),
  });
  const events = await createEvents({
    redisUrl: settings.redisUrl,
    connections,
    clock: systemClock,
    log,
    sessionValid: (principal) => identity.sessionActive(principal.sessionId),
  });
  if (events) {
    resources.add(events, (e) => e.close());
    await events.start();
  }
  const operations = new Operations({
    db,
    instanceId,
    role: "api",
    startedAt,
    log,
    metrics,
    eventsEnabled: !!events,
    eventsReady: () => events?.ready ?? false,
    version: "0.1.0",
  });
  startTelemetry(metrics, operations, resources);
  const app = await createApi({
    db,
    publicOrigin: installation.publicOrigin,
    consoleEnabled: settings.consoleEnabled,
    metrics,
    operations,
    identity,
    connections,
    router: new NativeRouter({
      connections,
      outbound: out,
      log: log.child({ component: "router" }),
      metrics,
    }),
    jobs,
    events,
    log: log.child({ component: "http" }),
  });
  resources.add(app, (a) => a.close());
  await app.listen({ port: settings.port, host: "0.0.0.0" });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : settings.port;
  log.info("api listening", { port, events: events !== undefined });
  return { port, stop: () => resources.close() };
}

export async function runWorker(loaded: Loaded): Promise<Running> {
  const resources = new Resources();
  return await resources.starting(() => startWorker(loaded, resources));
}

async function startWorker(loaded: Loaded, resources: Resources): Promise<Running> {
  const { settings, installation, log } = loaded;
  const db = database(settings, "worker", resources);
  await assertSchemaCurrent(db);
  const out = outbound(settings, resources);
  const instanceId = randomUUID(),
    startedAt = new Date();
  const metrics = new Metrics({ db, instanceId, log });
  const connections = connectionsFor(db, settings, installation, out, log, metrics);
  const jobs = new JobService({
    db,
    connections,
    limits: jobLimits(settings),
    publicOrigin: installation.publicOrigin,
    clock: systemClock,
    log: log.child({ component: "jobs" }),
  });
  const worker = new JobWorker({
    db,
    connections,
    jobs,
    clock: systemClock,
    log: log.child({ component: "worker" }),
    concurrency: settings.workerConcurrency,
  });
  const operations = new Operations({
    db,
    instanceId,
    role: "worker",
    startedAt,
    log,
    metrics,
    eventsEnabled: false,
    eventsReady: () => false,
    version: "0.1.0",
  });
  startTelemetry(metrics, operations, resources);
  const role = new WorkerRole({
    db,
    worker,
    maintenance: new Maintenance({
      db,
      jobs: worker,
      clock: systemClock,
      log: log.child({ component: "maintenance" }),
      cleanup: () => operations.cleanup(),
    }),
    log,
  });
  resources.add(role, (r) => r.stop());
  const port = await role.start(settings.workerHealthPort);
  log.info("worker running", { healthPort: port, concurrency: settings.workerConcurrency });
  return { port, stop: () => resources.close() };
}

async function main(argv: string[]): Promise<void> {
  const role = argv[0] as Role;
  const log = new Log();
  if (!ROLES.includes(role)) {
    log.error("unknown role", { role: argv[0] ?? null, roles: ROLES });
    process.exitCode = 2;
    return;
  }
  try {
    const loaded = load(process.env, log.child({ role }));
    if (role === "migrate") return await runMigrate(loaded);
    const running = role === "api" ? await runApi(loaded) : await runWorker(loaded);
    onShutdown(loaded.log, running.stop);
  } catch (error) {
    // The log treats a bare `code` as secret, so the stable error code goes under its own name.
    if (error instanceof ServiceError)
      log.error(error.message, {
        role,
        errorCode: error.code,
        ...(error.fields ? { fields: error.fields } : {}),
      });
    else log.error("startup failed", { role, error });
    process.exitCode = 1;
  }
}

if (import.meta.main) await main(process.argv.slice(2));
