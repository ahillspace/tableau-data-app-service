import { sql } from "kysely";
import type { Histogram, MetricSeries, MetricsView, MetricTotals } from "../contracts/operator.ts";
import type { Db } from "../persistence/database.ts";
import { type Clock, systemClock } from "../platform/clock.ts";
import { invalid, ServiceError } from "../platform/errors.ts";
import type { Log } from "../platform/log.ts";

export const MINUTE_MS = 60_000;
export const METRIC_RETENTION_MS = 7 * 86400_000;
export const HEARTBEAT_FRESH_MS = 45_000;
export const HISTOGRAM_BOUNDS = [
  10,
  25,
  50,
  100,
  250,
  500,
  1000,
  2500,
  5000,
  10000,
  30000,
  120000,
  null,
];
const MAX_SERIES = 4096;
// Reserve one overflow series per finite status in each of the two buffered minutes.
const PRIMARY_SERIES_LIMIT = MAX_SERIES - 2 * 503;
type Status = MetricSeries["status"];
type Counters = {
  requests: number;
  errors: number;
  histogram: number[];
  refresh: number;
  exchange: number;
};
type Bucket = Counters & {
  minute: number;
  definitionId: string;
  status: Status;
  sequence: number;
  saved: number;
};
const empty = (): Counters => ({
  requests: 0,
  errors: 0,
  histogram: HISTOGRAM_BOUNDS.map(() => 0),
  refresh: 0,
  exchange: 0,
});

function statusOf(value: unknown): Status | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599)
    return value;
  if (value === "transport-error" || value === "cancelled" || value === "service-error")
    return value;
  return undefined;
}

function count(value: string | number): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new ServiceError(503, "metrics-unavailable", "Metric counts exceed the supported range");
  return n;
}

function totals(c: Counters): MetricTotals {
  const samples = c.histogram.reduce((a, b) => count(a + b), 0);
  const percentile = (q: number) => {
    if (!samples) return null;
    let accumulated = 0;
    for (let i = 0; i < c.histogram.length; i++) {
      accumulated += c.histogram[i] ?? 0;
      if (accumulated >= Math.ceil(samples * q)) return HISTOGRAM_BOUNDS[i] ?? null;
    }
    return null;
  };
  const histogram: Histogram = { upperBoundsMs: [...HISTOGRAM_BOUNDS], counts: c.histogram };
  return {
    requests: c.requests,
    errors: c.errors,
    upstreamSamples: samples,
    upstreamHistogram: histogram,
    upstreamP50Ms: percentile(0.5),
    upstreamP95Ms: percentile(0.95),
    refreshFailures: c.refresh,
    exchangeFailures: c.exchange,
  };
}

/** Synchronous bounded recording; only flush/view touch Postgres. Each process start needs a new UUID. */
export class Metrics {
  readonly #db: Db;
  readonly #instanceId: string;
  readonly #clock: Clock;
  readonly #log: Log;
  readonly #buckets = new Map<string, Bucket>();
  #degraded = false;
  #flushedThrough: Date | null = null;
  #flushing: Promise<void> | undefined;

  constructor(options: { db: Db; instanceId: string; clock?: Clock; log: Log }) {
    this.#db = options.db;
    this.#instanceId = options.instanceId;
    this.#clock = options.clock ?? systemClock;
    this.#log = options.log;
  }

  get degraded(): boolean {
    return this.#degraded;
  }
  /** Published by the Operations heartbeat; null until one complete flush has succeeded. */
  get flushedThrough(): Date | null {
    return this.#flushedThrough ? new Date(this.#flushedThrough) : null;
  }

  #degrade(): void {
    this.#degraded = true;
  }

  #prune(now: number): void {
    const currentMinute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    for (const [key, row] of this.#buckets) {
      if (row.minute < currentMinute - MINUTE_MS) {
        if (row.saved !== row.sequence) this.#degrade();
        this.#buckets.delete(key);
      }
    }
  }

  #bucket(definitionId: string, status: Status): Bucket {
    const now = this.#clock.now().getTime();
    this.#prune(now);
    const minute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    // The routing owner supplies known definition IDs; malformed labels never retain request text.
    let label = /^[a-z0-9-]{1,63}$/.test(definitionId) ? definitionId : "_unknown";
    let key = `${minute}:${label}:${status}`;
    let row = this.#buckets.get(key);
    if (!row && this.#buckets.size >= PRIMARY_SERIES_LIMIT) {
      label = "_other";
      key = `${minute}:${label}:${status}`;
      row = this.#buckets.get(key);
      this.#degrade();
    }
    if (!row) {
      row = { ...empty(), minute, definitionId: label, status, sequence: 0, saved: 0 };
      this.#buckets.set(key, row);
    }
    row.sequence = count(row.sequence + 1);
    return row;
  }

  recordNative(input: { definitionId: string; status: Status; upstreamMs?: number }): void {
    try {
      const status = statusOf(input.status);
      if (status === undefined) {
        this.#degrade();
        return;
      }
      const row = this.#bucket(input.definitionId, status);
      row.requests = count(row.requests + 1);
      if (typeof status !== "number" || status >= 400) row.errors = count(row.errors + 1);
      if (input.upstreamMs !== undefined) {
        if (!Number.isFinite(input.upstreamMs) || input.upstreamMs < 0) {
          this.#degrade();
          return;
        }
        const index = HISTOGRAM_BOUNDS.findIndex(
          (bound) => bound === null || input.upstreamMs! <= bound,
        );
        row.histogram[index] = count((row.histogram[index] ?? 0) + 1);
      }
    } catch {
      this.#degrade();
    }
  }

  recordCredentialFailure(definitionId: string, operation: "refresh" | "exchange"): void {
    try {
      if (operation !== "refresh" && operation !== "exchange") {
        this.#degrade();
        return;
      }
      const row = this.#bucket(definitionId, "service-error");
      row[operation] = count(row[operation] + 1);
    } catch {
      this.#degrade();
    }
  }

  flush(): Promise<void> {
    if (this.#flushing) return this.#flushing;
    this.#flushing = this.#flush().finally(() => {
      this.#flushing = undefined;
    });
    return this.#flushing;
  }

  async #flush(): Promise<void> {
    try {
      const now = this.#clock.now().getTime();
      this.#prune(now);
      const snapshots = [...this.#buckets.values()]
        .filter((row) => row.sequence !== row.saved)
        .map((row) => ({ ...row, histogram: [...row.histogram] }));
      // Atomic cumulative replacement also makes a retry after an ambiguous commit harmless.
      await this.#db.transaction().execute(async (tx) => {
        for (const row of snapshots) {
          await sql`insert into metric_snapshots
            (instance_id, minute, definition_id, status, sequence, requests, errors,
             upstream_histogram, refresh_failures, exchange_failures)
            values (${this.#instanceId}::uuid, ${new Date(row.minute)}, ${row.definitionId},
              ${String(row.status)}, ${row.sequence}, ${row.requests}, ${row.errors},
              ${row.histogram}::bigint[], ${row.refresh}, ${row.exchange})
            on conflict (instance_id, minute, definition_id, status) do update set
              sequence = excluded.sequence, requests = excluded.requests, errors = excluded.errors,
              upstream_histogram = excluded.upstream_histogram,
              refresh_failures = excluded.refresh_failures, exchange_failures = excluded.exchange_failures
            where metric_snapshots.sequence < excluded.sequence`.execute(tx);
        }
      });
      for (const row of snapshots) {
        const current = this.#buckets.get(`${row.minute}:${row.definitionId}:${row.status}`);
        if (current) current.saved = row.sequence;
      }
      this.#flushedThrough = new Date(Math.floor(now / MINUTE_MS) * MINUTE_MS);
    } catch {
      this.#degrade();
      // Diagnostics carry only a fixed safe message, never an upstream error or a label.
      try {
        this.#log.warn("metric flush failed; telemetry coverage may be incomplete");
      } catch {}
    }
  }

  async view(
    filter: { from?: string; to?: string; definition?: string } = {},
  ): Promise<MetricsView> {
    const now = this.#clock.now();
    const complete = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
    const parse = (text: string | undefined, fallback: number) =>
      text === undefined ? fallback : Date.parse(text);
    const to = parse(filter.to, complete);
    const from = parse(filter.from, to - 3600_000);
    const fields = [];
    if (!Number.isFinite(from) || from % MINUTE_MS || from < complete - METRIC_RETENTION_MS)
      fields.push({ path: "from", rule: "retained-minute-aligned-time" });
    if (!Number.isFinite(to) || to % MINUTE_MS || to > complete)
      fields.push({ path: "to", rule: "complete-minute-aligned-time" });
    if (from >= to || to - from > 86400_000)
      fields.push({ path: "from", rule: "window:1-minute-to-24-hours" });
    if (filter.definition !== undefined && !/^[a-z0-9-]{1,63}$/.test(filter.definition))
      fields.push({ path: "definition", rule: "definition-id" });
    if (fields.length) throw invalid(fields);
    const selection = sql`minute >= ${new Date(from)} and minute < ${new Date(to)}
      ${filter.definition === undefined ? sql`` : sql`and definition_id = ${filter.definition}`}`;
    const { result, members } = await this.#db
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (tx) => {
        const result = await sql<{
          minute: Date;
          definition_id: string;
          status: string;
          requests: string;
          errors: string;
          histogram: string[];
          refresh: string;
          exchange: string;
        }>`with selected as (select * from metric_snapshots where ${selection}),
      counters as (
        select minute, definition_id, status, sum(requests)::text as requests,
          sum(errors)::text as errors, sum(refresh_failures)::text as refresh,
          sum(exchange_failures)::text as exchange
        from selected group by minute, definition_id, status
      ), buckets as (
        select minute, definition_id, status, position, sum(value) as value
        from selected cross join lateral unnest(upstream_histogram) with ordinality h(value, position)
        group by minute, definition_id, status, position
      ), histograms as (
        select minute, definition_id, status, array_agg(value::text order by position) as histogram
        from buckets group by minute, definition_id, status
      ) select * from counters join histograms using (minute, definition_id, status)
      order by minute, definition_id, status`.execute(tx);
        const members = await tx
          .selectFrom("process_heartbeats")
          .selectAll()
          .where("started_at", "<", new Date(to))
          .where("heartbeat_at", ">=", new Date(from - HEARTBEAT_FRESH_MS))
          .execute();
        return { result, members };
      });
    const combined = empty();
    const series: MetricSeries[] = result.rows.map((row) => {
      const status = statusOf(/^\d{3}$/.test(row.status) ? Number(row.status) : row.status);
      if (status === undefined || row.histogram.length !== HISTOGRAM_BOUNDS.length)
        throw new ServiceError(503, "metrics-unavailable", "Stored metric data is invalid");
      const c: Counters = {
        requests: count(row.requests),
        errors: count(row.errors),
        histogram: row.histogram.map(count),
        refresh: count(row.refresh),
        exchange: count(row.exchange),
      };
      combined.requests = count(combined.requests + c.requests);
      combined.errors = count(combined.errors + c.errors);
      combined.refresh = count(combined.refresh + c.refresh);
      combined.exchange = count(combined.exchange + c.exchange);
      for (let i = 0; i < combined.histogram.length; i++)
        combined.histogram[i] = count(combined.histogram[i]! + c.histogram[i]!);
      return {
        minute: row.minute.toISOString(),
        definitionId: row.definition_id,
        status,
        ...totals(c),
      };
    });
    const fresh = members.filter(
      (p) => now.getTime() - p.heartbeat_at.getTime() <= HEARTBEAT_FRESH_MS,
    );
    const watermarks = fresh.map((p) => p.flushed_through?.getTime());
    const coverageKnown = fresh.length > 0 && watermarks.every((n) => n !== undefined);
    const flushedThrough = coverageKnown
      ? new Date(Math.min(...(watermarks as number[]))).toISOString()
      : null;
    const mayBeIncomplete =
      this.#degraded ||
      !coverageKnown ||
      fresh.length !== members.length ||
      members.some((p) => p.degraded) ||
      (flushedThrough !== null && Date.parse(flushedThrough) < to);
    return {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      observedAt: now.toISOString(),
      flushedThrough,
      mayBeIncomplete,
      series,
      totals: totals(combined),
    };
  }
}
