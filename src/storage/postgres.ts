import pg from "pg";
import type {
  PgClient,
  PgClientQuery,
  PgClientResult,
  WithPgClient,
} from "postgraphile/@dataplan/pg";
import { makePgService } from "postgraphile/adaptors/pg";
import { openDatabase } from "../persistence/database.ts";
import { ServiceError } from "../platform/errors.ts";

export const identifier = pg.escapeIdentifier;
export const literal = pg.escapeLiteral;

export function storagePool(url: string, caCert: string | undefined, size: number): pg.Pool {
  return openDatabase({ url, caCert, applicationName: "tdas-storage", poolSize: size }).pool;
}

/** Reassert runner-owned settings immediately before each authored statement. */
export async function restoreRunnerSettings(
  client: pg.PoolClient,
  statementTimeoutMs: number,
  lockTimeoutMs: number,
): Promise<void> {
  if (
    !Number.isSafeInteger(statementTimeoutMs) ||
    statementTimeoutMs < 0 ||
    !Number.isSafeInteger(lockTimeoutMs) ||
    lockTimeoutMs < 0
  )
    throw new Error("Invalid PostgreSQL runner timeout");
  await client.query("set local standard_conforming_strings = on");
  await client.query(`set local statement_timeout = '${statementTimeoutMs}ms'`);
  await client.query(`set local lock_timeout = '${lockTimeoutMs}ms'`);
}

/** Use PostgreSQL's single-statement protocol for SQL submitted by an author. */
export function oneStatement(client: pg.PoolClient, text: string, values: unknown[] = []) {
  const config: pg.QueryConfig<unknown[]> & { queryMode: "extended" } = {
    text,
    values,
    queryMode: "extended",
  };
  return client.query(config);
}

/** Begin on the actual restricted login. Even a failing cleanup cannot return a dirty connection. */
export async function onScopedConnection<T>(
  pool: pg.Pool,
  schema: string,
  readOnly: boolean,
  actor: string | undefined,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let clean = false;
  try {
    await client.query(readOnly ? "begin read only" : "begin");
    try {
      const {
        rows: [admission],
      } = await client.query<{ active: boolean }>(
        "select storage_control.enter_workspace() as active",
      );
      if (!admission?.active)
        throw new ServiceError(409, "storage-workspace-inactive", "The workspace is inactive");
      await client.query(
        "select pg_catalog.set_config('search_path', $1, true), pg_catalog.set_config('tdas.actor_id', $2, true)",
        [identifier(schema), actor ?? ""],
      );
      const result = await work(client);
      try {
        const commit = await client.query("commit");
        if (commit.command !== "COMMIT")
          throw new ServiceError(
            409,
            "storage-rolled-back",
            "PostgreSQL rolled back the operation",
          );
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (
          readOnly ||
          error instanceof ServiceError ||
          (code && /^[0-9A-Z]{5}$/.test(code) && !code.startsWith("08"))
        )
          throw error;
        throw new ServiceError(
          503,
          "storage-commit-unknown",
          "The connection ended during commit. Check the operation outcome before retrying.",
        );
      }
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  } finally {
    try {
      await client.query("discard all");
      clean = true;
    } catch {
      // A failed reset destroys the connection without changing an acknowledged commit.
    } finally {
      client.release(!clean);
    }
  }
}

/** Grafast can issue concurrent plans and nested transactions on this connection.
 * Savepoint work is serialized at each nesting level. Use unnamed commands so DISCARD ALL
 * clears server-side state without leaving a stale driver-side prepared statement cache.
 */
class ScopedPgClient implements PgClient {
  #queue: Promise<unknown> = Promise.resolve();
  readonly #client: pg.PoolClient;
  readonly #level: number;
  constructor(client: pg.PoolClient, level = 0) {
    this.#client = client;
    this.#level = level;
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(run);
    this.#queue = result.catch(() => {});
    return result;
  }

  query<T>(opts: PgClientQuery): Promise<PgClientResult<T>> {
    const { text, arrayMode } = opts;
    const values = opts.values ?? [];
    return this.#serial(async () => {
      const { rows, rowCount } = arrayMode
        ? await this.#client.query({ text, values, rowMode: "array" })
        : await this.#client.query({ text, values });
      return { rows: rows as T[], rowCount };
    });
  }

  withTransaction<T>(work: (client: this) => Promise<T>): Promise<T> {
    return this.#serial(async () => {
      const name = `tdas_grafast_${this.#level}`;
      await this.#client.query(`savepoint ${name}`);
      try {
        const result = await work(new ScopedPgClient(this.#client, this.#level + 1) as this);
        await this.#client.query(`release savepoint ${name}`);
        return result;
      } catch (error) {
        await this.#client.query(`rollback to savepoint ${name}`);
        await this.#client.query(`release savepoint ${name}`);
        throw error;
      }
    });
  }
}

declare global {
  namespace Grafast {
    interface Context {
      storageWithPgClient: WithPgClient<PgClient>;
    }
  }
  namespace GraphileConfig {
    interface PgAdaptors {
      "tdas-storage": {
        client: PgClient;
        adaptorSettings: WithPgClient<PgClient>;
        makePgServiceOptions: never;
      };
    }
  }
}

export function workspacePgService(pool: pg.Pool, schema: string, readOnly: boolean) {
  const adaptorSettings: WithPgClient<PgClient> = (settings, work) =>
    onScopedConnection(
      pool,
      schema,
      readOnly || !settings,
      settings?.["tdas.actor_id"],
      async (c) => work(new ScopedPgClient(c)),
    );
  return {
    ...makePgService({
      pool,
      schemas: [schema],
      pubsub: false,
      withPgClientKey: "storageWithPgClient",
    }),
    adaptor: {
      createWithPgClient: (withClient, variant) => {
        if (variant) throw new Error("Storage has no privileged schema adapter");
        return withClient;
      },
      makePgService: () => {
        throw new Error("Storage services require a workspace pool");
      },
    },
    adaptorSettings,
  } satisfies GraphileConfig.PgServiceConfiguration<"tdas-storage">;
}
