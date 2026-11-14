import { type Kysely, sql } from "kysely";
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table deployments add column protocol_identity jsonb not null default '{}'`.execute(
    db,
  );
}
