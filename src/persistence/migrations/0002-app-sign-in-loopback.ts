import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table app_sign_ins
      add column redirect_uri text,
      add column client_state text,
      add constraint app_sign_ins_loopback_pair check ((redirect_uri is null) = (client_state is null));
  `.execute(db);
}
