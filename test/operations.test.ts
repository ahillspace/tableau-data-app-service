import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { sql } from "kysely";
import { Metrics } from "../src/operations/metrics.ts";
import { Operations } from "../src/operations/status.ts";
import { type Db, migrate, openDatabase } from "../src/persistence/database.ts";
import { Log } from "../src/platform/log.ts";
import { caCert, freshDatabaseUrl } from "./support/db.ts";

let db: Db;
let replica: Db;
let now: number;
const clock = { now: () => new Date(now) };
const log = new Log(() => {});
const minute = 60_000;
const range = () => ({
  from: new Date(now - (now % minute)).toISOString(),
  to: new Date(now - (now % minute) + minute).toISOString(),
});
const metrics = (pool = db, instanceId = randomUUID()) =>
  new Metrics({ db: pool, instanceId, clock, log });
const operations = (
  pool = db,
  instanceId = randomUUID(),
  telemetry?: Metrics,
  role: "api" | "worker" = "api",
) =>
  new Operations({
    db: pool,
    instanceId,
    role,
    startedAt: clock.now(),
    clock,
    log,
    ...(telemetry ? { metrics: telemetry } : {}),
    eventsEnabled: false,
    eventsReady: () => {
      throw new Error("disabled events must not be inspected");
    },
    version: "test",
  });

beforeEach(async () => {
  now = Date.parse("2026-11-17T07:40:05Z");
  const url = await freshDatabaseUrl();
  db = openDatabase({ url, caCert: caCert(), applicationName: "operations-a" }).db;
  replica = openDatabase({ url, caCert: caCert(), applicationName: "operations-b" }).db;
  await migrate(db);
});
afterEach(async () => {
  await Promise.all([db?.destroy(), replica?.destroy()]);
});

test("two instances merge disjoint histograms before computing percentiles", async () => {
  const a = metrics();
  const b = metrics(replica);
  for (let i = 0; i < 99; i++) a.recordNative({ definitionId: "chat", status: 200, upstreamMs: 9 });
  b.recordNative({ definitionId: "chat", status: 503, upstreamMs: 800 });
  b.recordCredentialFailure("chat", "refresh");
  b.recordCredentialFailure("chat", "exchange");
  a.recordNative({ definitionId: "other", status: "cancelled" });
  const interval = range();
  await Promise.all([a.flush(), b.flush()]);
  now += minute;
  const view = await a.view({ ...interval, definition: "chat" });
  assert.equal(view.totals.requests, 100);
  assert.equal(view.totals.errors, 1);
  assert.equal(view.totals.upstreamSamples, 100);
  assert.equal(view.totals.upstreamP50Ms, 10);
  assert.equal(view.totals.upstreamP95Ms, 10);
  assert.equal(view.totals.refreshFailures, 1);
  assert.equal(view.totals.exchangeFailures, 1);
  assert.equal(view.series.find((r) => r.status === "service-error")?.requests, 0);
  assert.equal(
    view.totals.upstreamHistogram.counts.reduce((x, y) => x + y, 0),
    100,
  );
  assert.equal(view.totals.upstreamHistogram.upperBoundsMs.at(-1), null);
  assert.equal((await a.view(interval)).totals.errors, 2);
});

test("concurrent flushes and cumulative replacement never double-count", async () => {
  const a = metrics();
  const interval = range();
  a.recordNative({ definitionId: "chat", status: 200, upstreamMs: 20 });
  await Promise.all([a.flush(), a.flush(), a.flush()]);
  a.recordNative({ definitionId: "chat", status: 200, upstreamMs: 40 });
  await a.flush();
  await a.flush();
  now += minute;
  const result = await a.view(interval);
  assert.equal(result.totals.requests, 2);
  assert.equal(result.totals.upstreamSamples, 2);
  assert.equal(result.totals.upstreamP50Ms, 25);
  assert.equal(result.totals.upstreamP95Ms, 50);
});

test("an older snapshot cannot replace a newer delivery for the same series", async () => {
  const id = randomUUID();
  const a = metrics(db, id);
  const interval = range();
  await sql`insert into metric_snapshots values (
    ${id}::uuid, ${interval.from}::timestamptz, 'chat', '200', 100, 7, 0,
    ${Array(13).fill(0)}::bigint[], 0, 0
  )`.execute(replica);
  a.recordNative({ definitionId: "chat", status: 200 });
  await a.flush();
  now += minute;
  assert.equal((await a.view(interval)).totals.requests, 7);
});

test("failed flushes retain cumulative data and retry without losing subsequent requests", async () => {
  const a = metrics();
  const interval = range();
  a.recordNative({ definitionId: "chat", status: 200 });
  await sql`alter table metric_snapshots rename to unavailable_snapshots`.execute(replica);
  await a.flush();
  assert.equal(a.degraded, true);
  assert.doesNotThrow(() => a.recordNative({ definitionId: "chat", status: 200 }));
  await sql`alter table unavailable_snapshots rename to metric_snapshots`.execute(replica);
  await a.flush();
  now += minute;
  const result = await a.view(interval);
  assert.equal(result.totals.requests, 2);
  assert.equal(result.mayBeIncomplete, true);
});

test("expired unflushed data is dropped and high cardinality folds into other", async () => {
  const a = metrics();
  const interval = range();
  a.recordNative({ definitionId: "lost", status: 200 });
  now += 3 * minute;
  a.recordNative({ definitionId: "current", status: 200 });
  await a.flush();
  assert.equal((await a.view(interval)).totals.requests, 0);
  for (let i = 0; i < 5000; i++) a.recordNative({ definitionId: `provider-${i}`, status: 200 });
  await a.flush();
  const rows = await db.selectFrom("metric_snapshots").selectAll().execute();
  assert.ok(rows.length <= 4096);
  assert.ok(rows.some((r) => r.definition_id === "_other"));
  assert.equal(a.degraded, true);
});

test("range validation rejects unaligned, future, expired and excessive windows", async () => {
  const a = metrics();
  const to = new Date(now - (now % minute)).toISOString();
  for (const from of [
    "invalid",
    new Date(now).toISOString(),
    new Date(now - 8 * 86400_000).toISOString(),
  ])
    await assert.rejects(a.view({ from, to }), { code: "invalid-request" });
  await assert.rejects(a.view({ from: to, to: new Date(now + 3600_000).toISOString() }), {
    code: "invalid-request",
  });
  await assert.rejects(
    a.view({ from: new Date(Date.parse(to) - 25 * 3600_000).toISOString(), to }),
    {
      code: "invalid-request",
    },
  );
  assert.equal((await a.view()).totals.upstreamP50Ms, null);
  assert.equal((await a.view()).flushedThrough, null);
});

test("heartbeats distinguish process restarts and age each replica independently", async () => {
  const a = operations();
  const b = operations(replica);
  await Promise.all([a.heartbeat(), b.heartbeat()]);
  now += 46_000;
  await b.heartbeat();
  const view = await a.status();
  assert.equal(view.processes.length, 2);
  assert.deepEqual(view.processes.map((p) => p.state).sort(), ["ok", "stale"]);
  assert.equal(view.events.state, "disabled");
  assert.equal(view.events.value, null);
  assert.equal(view.database.state, "ok");
  assert.equal(view.readiness.value?.ready, true);
  assert.equal(view.activity.value?.activeSessions, 0);
  now += 86400_000;
  await a.cleanup();
  assert.equal((await a.status()).processes.length, 0);
});

test("events unavailable differs from disabled, and observations retain stale prior counts", async () => {
  const a = new Operations({
    db,
    instanceId: randomUUID(),
    role: "api",
    startedAt: clock.now(),
    clock,
    log,
    eventsEnabled: true,
    eventsReady: () => false,
    version: "test",
  });
  const first = await a.status();
  assert.equal(first.events.state, "unavailable");
  assert.equal(first.readiness.value?.ready, false);
  await sql`alter table connections rename to unavailable_connections`.execute(replica);
  const next = await a.status();
  assert.equal(next.connections.state, "stale");
  assert.deepEqual(next.connections.value, first.connections.value);
  assert.equal(next.connections.observedAt, first.connections.observedAt);
});

test("retention cleanup deletes old telemetry in bounded batches", async () => {
  const a = metrics();
  const interval = range();
  a.recordNative({ definitionId: "chat", status: 200 });
  await a.flush();
  now += 8 * 86400_000;
  await operations().cleanup();
  assert.equal((await db.selectFrom("metric_snapshots").selectAll().execute()).length, 0);
  await assert.rejects(a.view(interval), { code: "invalid-request" });
});

test("worker watermarks, degradation and loss remain visible beside a healthy API", async () => {
  const apiId = randomUUID();
  const workerId = randomUUID();
  const apiMetrics = metrics(db, apiId);
  const workerMetrics = metrics(replica, workerId);
  const api = operations(db, apiId, apiMetrics);
  const worker = operations(replica, workerId, workerMetrics, "worker");
  const interval = range();
  workerMetrics.recordCredentialFailure("worker", "refresh");
  await workerMetrics.flush();
  await worker.heartbeat();
  now += minute;
  await apiMetrics.flush();
  await api.heartbeat();
  await worker.heartbeat();
  const lagging = await apiMetrics.view(interval);
  assert.equal(lagging.flushedThrough, interval.from);
  assert.equal(lagging.mayBeIncomplete, true);
  await workerMetrics.flush();
  await worker.heartbeat();
  assert.equal((await apiMetrics.view(interval)).mayBeIncomplete, false);
  workerMetrics.recordNative({ definitionId: "worker", status: 200, upstreamMs: -1 });
  await workerMetrics.flush();
  await worker.heartbeat();
  const degraded = await apiMetrics.view(interval);
  assert.equal(degraded.totals.requests, 0);
  assert.equal(degraded.totals.refreshFailures, 1);
  assert.equal(degraded.mayBeIncomplete, true);
  await db
    .updateTable("process_heartbeats")
    .set({ degraded: false })
    .where("instance_id", "=", workerId)
    .execute();
  now += 46_000;
  await apiMetrics.flush();
  await api.heartbeat();
  assert.equal((await apiMetrics.view(interval)).mayBeIncomplete, true);
});

test("cleanup preserves lost worker evidence across historical and oldest retained windows", async () => {
  const retention = 7 * 86400_000;
  const complete = now - (now % minute);
  const from = complete - retention;
  const workerId = randomUUID();
  await db
    .insertInto("process_heartbeats")
    .values({
      instance_id: workerId,
      role: "worker",
      started_at: new Date(from - minute),
      heartbeat_at: new Date(from - 45_000),
      flushed_through: null,
      degraded: false,
    })
    .execute();
  await sql`insert into metric_snapshots values (
    ${workerId}::uuid, ${new Date(from)}, 'worker', 'service-error', 1, 0, 0,
    ${Array(13).fill(0)}::bigint[], 0, 1
  )`.execute(db);
  const apiId = randomUUID();
  const apiMetrics = metrics(db, apiId);
  await apiMetrics.flush();
  const api = new Operations({
    db,
    instanceId: apiId,
    role: "api",
    startedAt: new Date(from - minute),
    clock,
    log,
    metrics: apiMetrics,
    eventsEnabled: false,
    eventsReady: () => false,
    version: "test",
  });
  await api.heartbeat();
  const interval = { from: new Date(from).toISOString(), to: new Date(from + minute).toISOString() };
  assert.equal((await apiMetrics.view(interval)).mayBeIncomplete, true);
  assert.equal((await api.status()).processes.some((p) => p.instanceId === workerId), false);
  await api.cleanup();
  const retained = await apiMetrics.view(interval);
  assert.equal(retained.mayBeIncomplete, true);
  assert.equal(retained.totals.exchangeFailures, 1);
  assert.ok(
    await db
      .selectFrom("process_heartbeats")
      .select("instance_id")
      .where("instance_id", "=", workerId)
      .executeTakeFirst(),
  );
  now += 2 * minute;
  await api.cleanup();
  assert.equal(
    await db
      .selectFrom("process_heartbeats")
      .select("instance_id")
      .where("instance_id", "=", workerId)
      .executeTakeFirst(),
    undefined,
  );
});
