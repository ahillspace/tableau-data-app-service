import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import type { Config } from "../config.js";
import type { CoreDatabase } from "./schema.js";

export type Database = Kysely<CoreDatabase>;
export type CoreTransaction = Transaction<CoreDatabase>;
export function createDatabase(config: Config, control = false): Database {
  const pool = new pg.Pool({
    connectionString: control
      ? (config.CONTROL_DATABASE_URL ?? config.DATABASE_URL)
      : config.DATABASE_URL,
    max: control ? config.DB_CONTROL_POOL_MAX : config.DB_POOL_MAX,
    connectionTimeoutMillis: config.DB_ACQUIRE_TIMEOUT_MS,
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
    lock_timeout: config.DB_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: config.DB_STATEMENT_TIMEOUT_MS,
    application_name: control ? "integration-control" : "integration-api",
  });
  pool.on("error", () => {
    process.stderr.write("Idle database connection failed\n");
  });
  return new Kysely<CoreDatabase>({ dialect: new PostgresDialect({ pool }) });
}
export async function databaseTime(db: Database | CoreTransaction): Promise<Date> {
  const row = (await sql<{ time: Date }>`select clock_timestamp() as time`.execute(db)).rows[0];
  if (!row) throw new Error("Database clock unavailable");
  return row.time;
}
export async function assertSchema(db: Database): Promise<void> {
  const result = await sql<{
    version: number;
  }>`select version from service_schema where singleton = true`.execute(db);
  if (result.rows[0]?.version !== 1)
    throw new Error("Incompatible service schema; run the migration owner command");
}
