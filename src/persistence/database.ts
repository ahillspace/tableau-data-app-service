import { Kysely, type Kysely as KyselyType, PostgresDialect, sql, type Transaction } from "kysely";
import { Migrator } from "kysely/migration";
import pg from "pg";
import { ServiceError } from "../platform/errors.ts";
import { migrations } from "./migrations/index.ts";
import type { Database } from "./schema.ts";

export type Db = KyselyType<Database>;
export type Tx = Transaction<Database>;
export type Queryable = Db | Tx;

// bigint columns (revision, counts) stay strings unless converted; timestamps stay Date.
pg.types.setTypeParser(20, (value) => value);

export type DatabaseOptions = {
  url: string;
  caCert?: string | undefined;
  applicationName: string;
  poolSize?: number;
};

/**
 * Opens a pool that always uses TLS and always verifies the server certificate.
 * Any `ssl*` parameters in the URL are removed so that verification cannot be turned off there.
 */
export function openDatabase(options: DatabaseOptions): { db: Db; pool: pg.Pool } {
  const url = new URL(options.url);
  for (const name of [...url.searchParams.keys()])
    if (name.startsWith("ssl") || name === "uselibpqcompat") url.searchParams.delete(name);
  const pool = new pg.Pool({
    connectionString: url.href,
    ssl: {
      rejectUnauthorized: true,
      ...(options.caCert ? { ca: options.caCert } : {}),
    },
    max: options.poolSize ?? 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    application_name: options.applicationName,
    statement_timeout: 30_000,
    lock_timeout: 10_000,
    idle_in_transaction_session_timeout: 60_000,
  });
  pool.on("error", () => {
    // An idle client failing is reported on its next use; nothing to do here.
  });
  return { db: new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }), pool };
}

export function migrator(db: Db): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
    migrationTableName: "schema_migrations",
    migrationLockTableName: "schema_migrations_lock",
  });
}

export async function migrate(db: Db): Promise<string[]> {
  const result = await migrator(db).migrateToLatest();
  if (result.error)
    throw new ServiceError(500, "migration-failed", "Database migration failed", {
      cause: result.error,
    });
  return (result.results ?? []).filter((r) => r.status === "Success").map((r) => r.migrationName);
}

/** Refuses to run against a schema that is behind or was created by another design. */
export async function assertSchemaCurrent(db: Db): Promise<void> {
  let pending: number;
  try {
    const all = await migrator(db).getMigrations();
    pending = all.filter((m) => m.executedAt === undefined).length;
  } catch (cause) {
    throw new ServiceError(
      500,
      "schema-unknown",
      "The database schema is not this service's schema",
      { cause },
    );
  }
  if (pending > 0)
    throw new ServiceError(
      500,
      "schema-behind",
      "The database schema is behind; run the migrate role first",
    );
}

export async function schemaIsCurrent(db: Db): Promise<boolean> {
  try {
    await assertSchemaCurrent(db);
    return true;
  } catch {
    return false;
  }
}

export async function databaseTime(db: Queryable): Promise<Date> {
  const row = await sql<{ now: Date }>`select clock_timestamp() as now`.execute(db);
  return row.rows[0]?.now ?? new Date();
}

export function transaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(fn);
}

/** Whether a Postgres error is a unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === "23505";
}
