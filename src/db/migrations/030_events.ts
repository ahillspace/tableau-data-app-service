import { type Kysely, sql } from "kysely";

export async function up<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    create table event_sources (
      id text primary key,
      provider_registration_id text not null references provider_registrations(id),
      setup_kind text not null check(setup_kind in ('manual','app','service')),
      owner_id text references owners(id),
      setup_owner_id text not null references owners(id),
      setup_app_id text not null references apps(id),
      connection_id text references connections(id),
      authority_generation integer,
      account_key text not null,
      revision integer not null default 1 check(revision > 0),
      state text not null check(state in ('configured','active','attention-required','retired')),
      verified boolean not null default false,
      private_context jsonb not null,
      provider_expires_at timestamptz,
      renew_after timestamptz,
      claim_token text,
      claim_incarnation text,
      lease_until timestamptz,
      operation text check(operation in ('create','renew','retire')),
      phase text check(phase in ('claimed','may-have-dispatched','uncertain')),
      check((connection_id is null) = (authority_generation is null)),
      check((claim_token is null) = (claim_incarnation is null)),
      check((claim_token is null) = (lease_until is null)),
      check((state not in ('active','attention-required')) or verified)
    );
    create table event_source_audience (
      source_id text not null references event_sources(id) on delete cascade,
      deployment_id text not null,
      site_id text not null,
      subject_id text not null,
      primary key(source_id,deployment_id,site_id,subject_id),
      foreign key(deployment_id,site_id) references tableau_sites(deployment_id,site_id)
    );
    create index event_source_connection on event_sources(connection_id) where state <> 'retired';
    create index event_source_maintenance on event_sources(renew_after) where state <> 'retired';
  `.execute(db);
}
