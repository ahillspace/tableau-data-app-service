import { type Kysely, sql } from "kysely";
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table authorizations (
      id text primary key, provider_registration_id text not null references provider_registrations(id), app_id text not null references apps(id),
      session_id text not null references sessions(id), owner_id text not null references owners(id), mutation_id text not null unique references credential_mutations(id),
      initiation_verifier text not null, browser_verifier text, state_verifier text unique, protected_state jsonb,
      state text not null check(state in ('pending','exchanging','succeeded','failed','cancelled','expired')), launched boolean not null default false,
      expires_at timestamptz not null, connection_id text references connections(id)
    );
    create index authorization_expiry on authorizations(expires_at);
    create index mutation_session on credential_mutations(access_session_id);
  `.execute(db);
}
