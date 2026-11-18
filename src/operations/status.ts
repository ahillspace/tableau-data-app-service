import { sql } from "kysely";
import type { Observation, StatusView } from "../contracts/operator.ts";
import { type Db, databaseTime, schemaIsCurrent } from "../persistence/database.ts";
import { currentRevision } from "../persistence/revision.ts";
import { type Clock, systemClock } from "../platform/clock.ts";
import type { Log } from "../platform/log.ts";
import { HEARTBEAT_FRESH_MS, METRIC_RETENTION_MS, type Metrics, MINUTE_MS } from "./metrics.ts";

type Options = {
  db: Db;
  instanceId: string;
  role: "api" | "worker";
  startedAt: Date;
  clock?: Clock;
  log: Log;
  metrics?: Metrics;
  eventsEnabled: boolean;
  eventsReady: () => boolean;
  version: string;
};

/** Observations remain independent: a failed count does not turn an old count into a healthy one. */
export class Operations {
  readonly #options: Options;
  readonly #clock: Clock;
  readonly #prior = new Map<string, Observation<unknown>>();
  #processes: StatusView["processes"] = [];
  #revision: number | undefined;

  constructor(options: Options) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
  }

  async heartbeat(): Promise<void> {
    const o = this.#options;
    try {
      await o.db
        .insertInto("process_heartbeats")
        .values({
          instance_id: o.instanceId,
          role: o.role,
          started_at: o.startedAt,
          heartbeat_at: this.#clock.now(),
          flushed_through: o.metrics?.flushedThrough ?? null,
          degraded: o.metrics?.degraded ?? false,
        })
        .onConflict((c) =>
          c.column("instance_id").doUpdateSet({
            heartbeat_at: this.#clock.now(),
            flushed_through: o.metrics?.flushedThrough ?? null,
            degraded: o.metrics?.degraded ?? false,
          }),
        )
        .execute();
    } catch {
      try {
        o.log.warn("process heartbeat failed; process freshness is unknown");
      } catch {}
    }
  }

  async #observe<T>(name: string, read: () => Promise<T>): Promise<Observation<T>> {
    try {
      const observation: Observation<T> = {
        state: "ok",
        observedAt: this.#clock.now().toISOString(),
        value: await read(),
      };
      this.#prior.set(name, observation);
      return observation;
    } catch {
      const prior = this.#prior.get(name) as Observation<T> | undefined;
      return prior
        ? { ...prior, state: "stale" }
        : { state: "unavailable", observedAt: null, value: null };
    }
  }

  async status(): Promise<StatusView> {
    const { db, eventsEnabled, eventsReady, version } = this.#options;
    const now = this.#clock.now();
    const database = await this.#observe("database", async () => {
      await databaseTime(db);
      return { reachable: true };
    });
    const events: StatusView["events"] = !eventsEnabled
      ? { state: "disabled", observedAt: now.toISOString(), value: null }
      : await this.#observe("events", async () => ({ connected: eventsReady() }));
    if (eventsEnabled && events.state === "ok" && !events.value?.connected)
      events.state = "unavailable";
    const readiness = await this.#observe("readiness", async () => ({
      ready:
        database.state === "ok" &&
        (await schemaIsCurrent(db)) &&
        (!eventsEnabled || events.value?.connected === true),
    }));
    // Revision is required by the shared view. With no successful read yet, fail the view honestly.
    try {
      this.#revision = Number(await currentRevision(db));
    } catch (error) {
      if (this.#revision === undefined) throw error;
    }
    const [connections, jobs, activity] = await Promise.all([
      this.#observe("connections", async () => {
        const rows = await db
          .selectFrom("connections")
          .select(["status", sql<string>`count(*)::text`.as("count")])
          .groupBy("status")
          .execute();
        const counts = { connected: 0, "needs-authorization": 0, disconnected: 0 };
        for (const row of rows) counts[row.status] = Number(row.count);
        return counts;
      }),
      this.#observe("jobs", async () => {
        const rows = await db
          .selectFrom("jobs")
          .select(["state", sql<string>`count(*)::text`.as("count")])
          .groupBy("state")
          .execute();
        return Object.fromEntries(rows.map((row) => [row.state, Number(row.count)]));
      }),
      this.#observe("activity", async () => {
        const result = await sql<{
          sessions: string;
          apps: string;
        }>`select count(*)::text as sessions,
          count(distinct case when a.kind = 'app' then registry.app_id end)::text as apps
          from app_sessions a join sign_in_sessions s on s.id = a.sign_in_session_id
          join identities i on i.id = a.identity_id and s.identity_id = i.id
          join trusted_sites t on t.deployment_id = i.deployment_id and t.site_id = i.site_id and t.enabled
          left join apps registry on registry.app_id = a.app_id
          where a.expires_at > ${now} and s.expires_at > ${now}
            and a.last_seen_at > ${new Date(now.getTime() - 900_000)}
            and (a.kind = 'app' or exists (select 1 from operators o where o.deployment_id = i.deployment_id
              and o.site_id = i.site_id and o.user_id = i.user_id))`.execute(db);
        return {
          windowSeconds: 900 as const,
          activeSessions: Number(result.rows[0]!.sessions),
          activeApps: Number(result.rows[0]!.apps),
        };
      }),
    ]);
    try {
      const rows = await db
        .selectFrom("process_heartbeats")
        .selectAll()
        .where("heartbeat_at", ">", new Date(now.getTime() - 86400_000))
        .orderBy("role")
        .orderBy("started_at")
        .execute();
      this.#processes = rows.map((row) => ({
        instanceId: row.instance_id,
        role: row.role,
        startedAt: row.started_at.toISOString(),
        lastHeartbeatAt: row.heartbeat_at.toISOString(),
        state: now.getTime() - row.heartbeat_at.getTime() > HEARTBEAT_FRESH_MS ? "stale" : "ok",
        uptimeSeconds: Math.max(0, Math.floor((now.getTime() - row.started_at.getTime()) / 1000)),
      }));
    } catch {
      this.#processes = this.#processes.map((p) => ({ ...p, state: "stale" }));
    }
    return {
      observedAt: now.toISOString(),
      version,
      revision: this.#revision!,
      database,
      events,
      readiness,
      connections,
      jobs,
      activity,
      processes: this.#processes,
    };
  }

  async cleanup(): Promise<{ metrics: number; heartbeats: number }> {
    const now = this.#clock.now().getTime();
    const report = { metrics: 0, heartbeats: 0 };
    for (const [table, cutoff, key] of [
      ["metric_snapshots", now - METRIC_RETENTION_MS - MINUTE_MS, "metrics"],
      ["process_heartbeats", now - METRIC_RETENTION_MS - MINUTE_MS - HEARTBEAT_FRESH_MS, "heartbeats"],
    ] as const) {
      const column = table === "metric_snapshots" ? "minute" : "heartbeat_at";
      for (let i = 0; i < 20; i++) {
        const result = await sql`delete from ${sql.table(table)} where ctid in
          (select ctid from ${sql.table(table)} where ${sql.ref(column)} <= ${new Date(cutoff)} limit 500)`.execute(
          this.#options.db,
        );
        const removed = Number(result.numAffectedRows ?? 0);
        report[key] += removed;
        if (removed < 500) break;
      }
    }
    return report;
  }
}
