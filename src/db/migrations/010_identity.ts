import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table session_transactions (
      id text primary key, deployment_id text not null references deployments(id), app_id text not null references apps(id),
      initiation_verifier text not null, state text not null check(state in ('pending','launched','exchanging','succeeded','failed','redeemed')),
      state_verifier text unique, browser_verifier text, protected_state jsonb, expires_at timestamptz not null,
      session_id text references sessions(id), claim_token text, claim_incarnation text, claim_until timestamptz,
      check((claim_token is null) = (claim_incarnation is null)), check((claim_token is null) = (claim_until is null))
    );
    create index session_transaction_expiry on session_transactions(expires_at);
    create table restoration_bindings (verifier text primary key, session_id text not null references sessions(id) on delete cascade, browser_profile text not null, created_at timestamptz not null default clock_timestamp());
    create index restoration_session on restoration_bindings(session_id);
  `.execute(db);
}
