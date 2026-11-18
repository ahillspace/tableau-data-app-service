import { sql } from "kysely";
import type { JobWorker } from "../jobs/worker.ts";
import type { Db } from "../persistence/database.ts";
import type { Clock } from "../platform/clock.ts";
import type { Log } from "../platform/log.ts";

/**
 * Tables whose rows end at `expires_at`. Deleting a sign-in session cascades to the restore tokens,
 * app sessions and sign-ins issued from it, so those go with their parent as well as on their own.
 */
export const EXPIRING_TABLES = [
  "sign_in_transactions",
  "app_sign_ins",
  "operator_sign_ins",
  "connect_transactions",
  "restore_tokens",
  "app_sessions",
  "sign_in_sessions",
] as const;

export type MaintenanceReport = Record<
  (typeof EXPIRING_TABLES)[number] | "jobResults" | "jobRecords",
  number
>;

/** Deletes expired rows in bounded batches until none remain or the pass reaches its batch budget. */
export class Maintenance {
  readonly #db: Db;
  readonly #jobs: Pick<JobWorker, "cleanup">;
  readonly #clock: Clock;
  readonly #log: Log;
  readonly #batch: number;
  readonly #maxBatches: number;
  readonly #cleanup: (() => Promise<unknown>) | undefined;
  #lastRun = 0;

  constructor(options: {
    db: Db;
    jobs: Pick<JobWorker, "cleanup">;
    clock: Clock;
    log: Log;
    batchSize?: number;
    maxBatchesPerTable?: number;
    cleanup?: () => Promise<unknown>;
  }) {
    this.#db = options.db;
    this.#cleanup = options.cleanup;
    this.#jobs = options.jobs;
    this.#clock = options.clock;
    this.#log = options.log;
    this.#batch = options.batchSize ?? 500;
    this.#maxBatches = options.maxBatchesPerTable ?? 20;
  }

  /** When the last pass finished without error, in epoch milliseconds; 0 before the first. */
  get lastRun(): number {
    return this.#lastRun;
  }

  async run(): Promise<MaintenanceReport> {
    const now = this.#clock.now();
    const report = { jobResults: 0, jobRecords: 0 } as MaintenanceReport;
    for (const table of EXPIRING_TABLES) {
      report[table] = 0;
      for (let i = 0; i < this.#maxBatches; i++) {
        // The table name is one of the constants above, never input.
        const deleted = await sql`
          delete from ${sql.table(table)} where id in (
            select id from ${sql.table(table)} where expires_at <= ${now} limit ${this.#batch}
          )`.execute(this.#db);
        const count = Number(deleted.numAffectedRows ?? 0);
        report[table] += count;
        if (count < this.#batch) break;
      }
    }
    for (let i = 0; i < this.#maxBatches; i++) {
      const { results, records } = await this.#jobs.cleanup();
      report.jobResults += results;
      report.jobRecords += records;
      if (results < this.#batch && records < this.#batch) break;
    }
    await this.#cleanup?.();
    this.#lastRun = Date.now();
    const total = Object.values(report).reduce((a, b) => a + b, 0);
    if (total) this.#log.info("maintenance removed expired rows", report);
    return report;
  }
}
