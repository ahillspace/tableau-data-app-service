import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table service_schema (singleton boolean primary key default true check(singleton), version integer not null);
    insert into service_schema values (true, 1);
    create table deployments (id text primary key, kind text not null check(kind in ('cloud','server')), adapter_id text not null, config_revision integer not null check(config_revision > 0), enabled boolean not null);
    create table tableau_sites (id text primary key, deployment_id text not null references deployments(id), site_id text not null, enabled boolean not null, created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(), unique(deployment_id,site_id));
    create table site_changes (id text primary key, site_id text not null references tableau_sites(id), actor_id text not null, enabled boolean not null, changed_at timestamptz not null default clock_timestamp());
    create table owners (id text primary key, deployment_id text not null, site_id text not null, subject_id text not null, unique(deployment_id,site_id,subject_id), foreign key(deployment_id,site_id) references tableau_sites(deployment_id,site_id));
    create table sessions (id text primary key, owner_id text not null references owners(id), verified_at timestamptz not null, authentication_expires_at timestamptz not null, revoked boolean not null default false, adapter_id text not null, check(authentication_expires_at > verified_at));
    create table access_tokens (verifier text primary key, session_id text not null references sessions(id) on delete cascade, expires_at timestamptz not null);
    create index access_token_expiry on access_tokens(expires_at);
    create index session_expiry on sessions(authentication_expires_at);
    create table apps (id text primary key, enabled boolean not null, config_revision integer not null check(config_revision > 0), defaults jsonb not null default '{}');
    create table provider_registrations (id text primary key, enabled boolean not null, config_revision integer not null check(config_revision > 0), mode text not null check(mode in ('none','personal','operator')), reauth_seconds integer check(reauth_seconds > 0));
    create table connections (id text primary key, provider_registration_id text not null references provider_registrations(id), owner_id text references owners(id), state text not null check(state in ('active','reauthorization-required','renewal-uncertain','disconnected')), authority_generation integer not null check(authority_generation > 0), credential_generation integer not null check(credential_generation > 0), last_connector_reauth_at timestamptz, display jsonb not null default '{}', account_key text, bundle jsonb, credential_expires_at timestamptz, mutation_id text, check(state <> 'disconnected' or bundle is null));
    create index connection_owner on connections(owner_id,provider_registration_id);
    create table connection_audience (connection_id text not null references connections(id), deployment_id text not null, site_id text not null, subject_id text not null, primary key(connection_id,deployment_id,site_id,subject_id), foreign key(deployment_id,site_id) references tableau_sites(deployment_id,site_id));
    create table credential_mutations (id text primary key, connection_id text references connections(id), setup_id text, kind text not null check(kind in ('setup','import','renewal')), expected_authority integer not null, expected_credential integer not null, expires_at timestamptz not null, phase text not null check(phase in ('reserved','processing','waiting','dispatched','uncertain','succeeded','failed')), may_invalidate boolean not null default false, processor_token text, incarnation text, lease_until timestamptz, access_session_id text references sessions(id), evidence text, check((connection_id is null) <> (setup_id is null)), check((processor_token is null) = (incarnation is null)), check((processor_token is null) = (lease_until is null)));
    alter table connections add constraint mutation_owner foreign key(mutation_id) references credential_mutations(id);
    create index mutation_recovery on credential_mutations(expires_at) where phase not in ('succeeded','failed','uncertain');
  `.execute(db);
}
