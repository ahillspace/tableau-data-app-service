import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create extension if not exists pgcrypto;

    create table installation_revision (
      id integer primary key check (id = 1),
      revision bigint not null
    );
    insert into installation_revision (id, revision) values (1, 1);

    create table deployments (
      id text primary key,
      kind text not null,
      pod_origin text not null,
      created_at timestamptz not null default clock_timestamp()
    );

    create table trusted_sites (
      id uuid primary key default gen_random_uuid(),
      deployment_id text not null references deployments(id),
      content_url text not null,
      site_id text,
      enabled boolean not null default true,
      created_at timestamptz not null default clock_timestamp(),
      bound_at timestamptz
    );
    create unique index trusted_sites_bound on trusted_sites (deployment_id, site_id) where site_id is not null;
    create unique index trusted_sites_named on trusted_sites (deployment_id, lower(content_url)) where site_id is null;

    create table operators (
      id uuid primary key default gen_random_uuid(),
      deployment_id text not null references deployments(id),
      site_content_url text not null,
      username text not null,
      site_id text,
      user_id text,
      created_at timestamptz not null default clock_timestamp(),
      bound_at timestamptz,
      check ((site_id is null) = (user_id is null))
    );
    create unique index operators_bound on operators (deployment_id, site_id, user_id) where site_id is not null;
    create unique index operators_named on operators (deployment_id, lower(site_content_url), lower(username)) where site_id is null;

    create table identities (
      id uuid primary key default gen_random_uuid(),
      deployment_id text not null references deployments(id),
      site_id text not null,
      user_id text not null,
      site_content_url text not null,
      user_name text not null,
      last_verified_at timestamptz not null,
      created_at timestamptz not null default clock_timestamp(),
      unique (deployment_id, site_id, user_id)
    );

    create table sign_in_transactions (
      id uuid primary key default gen_random_uuid(),
      state_hash text not null unique,
      browser_hash text not null,
      deployment_id text not null references deployments(id),
      pkce_verifier text not null,
      nonce text not null,
      return_to text not null,
      expires_at timestamptz not null
    );
    create index sign_in_transactions_expiry on sign_in_transactions (expires_at);

    create table sign_in_sessions (
      id uuid primary key default gen_random_uuid(),
      cookie_hash text not null unique,
      identity_id uuid not null references identities(id) on delete cascade,
      verified_at timestamptz not null,
      expires_at timestamptz not null,
      created_at timestamptz not null default clock_timestamp()
    );
    create index sign_in_sessions_identity on sign_in_sessions (identity_id);
    create index sign_in_sessions_expiry on sign_in_sessions (expires_at);

    create table restore_tokens (
      id uuid primary key default gen_random_uuid(),
      token_hash text not null unique,
      sign_in_session_id uuid not null references sign_in_sessions(id) on delete cascade,
      expires_at timestamptz not null,
      created_at timestamptz not null default clock_timestamp()
    );
    create index restore_tokens_expiry on restore_tokens (expires_at);

    create table app_sign_ins (
      id uuid primary key default gen_random_uuid(),
      proof_hash text not null,
      app_id text not null,
      attribution jsonb not null,
      code_hash text unique,
      sign_in_session_id uuid references sign_in_sessions(id) on delete cascade,
      expires_at timestamptz not null,
      redeemed_at timestamptz,
      created_at timestamptz not null default clock_timestamp()
    );
    create index app_sign_ins_expiry on app_sign_ins (expires_at);

    create table app_sessions (
      id uuid primary key default gen_random_uuid(),
      bearer_hash text not null unique,
      kind text not null check (kind in ('app', 'operator')),
      identity_id uuid not null references identities(id) on delete cascade,
      sign_in_session_id uuid not null references sign_in_sessions(id) on delete cascade,
      app_id text,
      attribution jsonb not null,
      location jsonb not null,
      expires_at timestamptz not null,
      created_at timestamptz not null default clock_timestamp()
    );
    create index app_sessions_identity on app_sessions (identity_id);
    create index app_sessions_expiry on app_sessions (expires_at);

    create table operator_sign_ins (
      id uuid primary key default gen_random_uuid(),
      mode text not null check (mode in ('loopback', 'popup')),
      redirect_uri text,
      code_challenge text not null,
      client_state text,
      consent_hash text,
      code_hash text unique,
      sign_in_session_id uuid references sign_in_sessions(id) on delete cascade,
      expires_at timestamptz not null,
      redeemed_at timestamptz,
      created_at timestamptz not null default clock_timestamp()
    );
    create index operator_sign_ins_expiry on operator_sign_ins (expires_at);

    create table apps (
      app_id text primary key,
      first_seen_at timestamptz not null,
      last_seen_at timestamptz not null,
      session_count bigint not null default 0,
      site_ids text[] not null default '{}',
      workbooks text[] not null default '{}'
    );

    create table definitions (
      id text primary key,
      display_name text not null,
      type text not null,
      ownership text not null check (ownership in ('shared', 'personal')),
      api_hosts jsonb not null,
      authorization_endpoint text,
      token_endpoint text,
      client_id text,
      token_authentication text check (token_authentication in ('basic', 'post')),
      scopes jsonb not null,
      preset_options jsonb not null,
      credential_placement jsonb not null,
      audience jsonb not null,
      reauthorization_interval integer,
      private_hosts boolean not null,
      enabled boolean not null,
      retired boolean not null default false,
      generation integer not null default 1,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      retired_at timestamptz
    );

    create table definition_secrets (
      definition_id text not null references definitions(id),
      field text not null check (field in ('clientSecret', 'signingSecret')),
      sealed jsonb not null,
      set_at timestamptz not null,
      primary key (definition_id, field)
    );

    create table secret_links (
      id uuid primary key default gen_random_uuid(),
      token_hash text not null unique,
      definition_id text not null references definitions(id),
      generation integer not null,
      field text not null check (field in ('clientSecret', 'signingSecret', 'credential')),
      created_by text not null,
      expires_at timestamptz not null,
      used_at timestamptz,
      created_at timestamptz not null default clock_timestamp()
    );
    create index secret_links_expiry on secret_links (expires_at);

    create table connections (
      id uuid primary key default gen_random_uuid(),
      definition_id text not null references definitions(id),
      generation integer not null,
      owner_identity_id uuid references identities(id),
      status text not null check (status in ('connected', 'needs-authorization', 'disconnected')),
      sealed jsonb,
      account text,
      account_name text,
      scopes jsonb not null default '[]',
      authorized_at timestamptz not null,
      credential_expires_at timestamptz,
      disconnected_at timestamptz,
      disconnect_reason text,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      check ((status = 'disconnected') = (sealed is null))
    );
    create unique index connections_shared_live on connections (definition_id)
      where owner_identity_id is null and status <> 'disconnected';
    create unique index connections_personal_live on connections (definition_id, owner_identity_id)
      where owner_identity_id is not null and status <> 'disconnected';

    create table connect_transactions (
      id uuid primary key default gen_random_uuid(),
      state_hash text unique,
      definition_id text not null references definitions(id),
      generation integer not null,
      identity_id uuid not null references identities(id) on delete cascade,
      shared boolean not null,
      pkce_verifier text,
      started boolean not null default false,
      status text not null default 'pending' check (status in ('pending', 'connected', 'failed')),
      failure text,
      expires_at timestamptz not null,
      created_at timestamptz not null default clock_timestamp()
    );
    create index connect_transactions_expiry on connect_transactions (expires_at);

    create table jobs (
      id uuid primary key default gen_random_uuid(),
      handler text not null,
      definition_id text,
      owner_identity_id uuid not null references identities(id),
      app_id text not null,
      submission_key text not null,
      input_hash text not null,
      input jsonb not null,
      state text not null check (state in ('queued','running','waiting','succeeded','failed','cancelled','interrupted')),
      progress jsonb,
      attempt integer not null default 0,
      lease_owner text,
      lease_expires_at timestamptz,
      run_after timestamptz not null,
      deadline_at timestamptz,
      external_task_id text,
      callback_verifier_hash text,
      resume jsonb,
      resuming jsonb,
      cancel_requested boolean not null default false,
      remote_effects_unknown boolean not null default false,
      earlier_effects_unknown boolean not null default false,
      error jsonb,
      created_at timestamptz not null default clock_timestamp(),
      started_at timestamptz,
      finished_at timestamptz,
      result_expires_at timestamptz,
      record_expires_at timestamptz,
      unique (owner_identity_id, handler, submission_key)
    );
    create index jobs_due on jobs (run_after) where state = 'queued';
    create index jobs_leases on jobs (lease_expires_at) where state = 'running';
    create index jobs_waiting on jobs (run_after) where state = 'waiting';
    create index jobs_record_expiry on jobs (record_expires_at) where record_expires_at is not null;
    create index jobs_owner on jobs (owner_identity_id, created_at desc);

    create table job_results (
      job_id uuid primary key references jobs(id) on delete cascade,
      result jsonb not null,
      size integer not null,
      expires_at timestamptz not null
    );
    create index job_results_expiry on job_results (expires_at);

    create table audit (
      id bigserial primary key,
      at timestamptz not null default clock_timestamp(),
      actor text not null,
      action text not null,
      target text,
      detail jsonb not null default '{}'
    );
  `.execute(db);
}
