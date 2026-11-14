import { type Kysely, sql } from "kysely";
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table authorizations alter column session_id drop not null, alter column owner_id drop not null;
    alter table authorizations add column operator_context jsonb;
    alter table authorizations add constraint authorization_principal check ((operator_context is null and session_id is not null and owner_id is not null) or (operator_context is not null and session_id is null and owner_id is null));`.execute(
    db,
  );
}
