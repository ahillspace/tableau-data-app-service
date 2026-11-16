import { sql } from "kysely";
import type { Queryable, Tx } from "./database.ts";

/** Increments the installation revision inside a transaction that writes definitions, sites or operators. */
export async function bumpRevision(tx: Tx): Promise<void> {
  await sql`update installation_revision set revision = revision + 1 where id = 1`.execute(tx);
}

export async function currentRevision(db: Queryable): Promise<bigint> {
  const row = await db
    .selectFrom("installation_revision")
    .select("revision")
    .where("id", "=", 1)
    .executeTakeFirstOrThrow();
  return BigInt(row.revision);
}
