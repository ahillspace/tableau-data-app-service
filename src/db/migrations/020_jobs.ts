import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create table jobs (
    id text primary key, app_id text not null references apps(id), owner_id text not null references owners(id),
    deployment_id text not null, site_id text not null, subject_id text not null,
    submission_id text not null, capability_id text not null, capability_version integer not null,
    provider_registration_id text not null references provider_registrations(id), provider_revision integer not null,
    connection_id text references connections(id), authority_generation integer, account_key text,
    comparison_version integer not null, comparison_digest text not null, comparison_schema jsonb not null,
    input_limit integer not null check(input_limit>0), result_limit integer not null check(result_limit>0),
    execution_seconds integer not null check(execution_seconds>0), result_retention_ms double precision not null,
    metadata_retention_ms double precision not null,
    state text not null check(state in ('queued','running','waiting-provider','succeeded','failed','cancelled')),
    revision integer not null, submitted_at timestamptz not null, started_at timestamptz, deadline timestamptz,
    completed_at timestamptz, result_expires_at timestamptz, record_expires_at timestamptz, has_result boolean not null default false,
    due_at timestamptz not null, claim_token text, incarnation text, claim_kind text, lease_until timestamptz,
    attempts integer not null default 0, invocation_token text, invocation_incarnation text,
    requested boolean not null default false, remote_status text not null default 'not-requested',
    blocked_reason text, progress jsonb, error jsonb, task_id text, callback_correlation text,
    cleanup_deadline timestamptz, cleanup_token text, cleanup_incarnation text, cleanup_lease timestamptz, cancel_issued_at timestamptz,
    unique(app_id,owner_id,submission_id),
    check ((completed_at is null) = (state in ('queued','running','waiting-provider'))),
    check ((claim_token is null) = (incarnation is null)),
    check ((claim_token is null) = (lease_until is null)),
    check ((started_at is null) = (deadline is null)),
    check (state <> 'waiting-provider' or task_id is not null)
  )`.execute(db);
  await sql`create table job_payloads (
    job_id text not null references jobs(id) on delete cascade deferrable initially deferred, kind text not null check(kind in ('input','result','task')),
    revision text not null, bytes integer not null check(bytes>=0), key_id text not null,
    nonce bytea not null check(octet_length(nonce)=12), tag bytea not null check(octet_length(tag)=16), body bytea not null,
    primary key(job_id,kind)
  )`.execute(db);
  await sql`create index jobs_due on jobs(due_at,submitted_at,id) where state in ('queued','waiting-provider')`.execute(
    db,
  );
  await sql`create index jobs_ready_kind on jobs(state,due_at,submitted_at,id) where claim_token is null and state in ('queued','waiting-provider')`.execute(
    db,
  );
  await sql`create index jobs_cleanup_leases on jobs(cleanup_lease,id) where remote_status='pending' and cleanup_lease is not null`.execute(
    db,
  );
  await sql`create index jobs_leases on jobs(lease_until,id) where claim_token is not null`.execute(
    db,
  );
  await sql`create index jobs_deadlines on jobs(deadline,id) where completed_at is null and deadline is not null`.execute(
    db,
  );
  await sql`create index jobs_cancellation on jobs(due_at,id) where requested and completed_at is null`.execute(
    db,
  );
  await sql`create index jobs_results on jobs(result_expires_at,id) where has_result`.execute(db);
  await sql`create index jobs_retention on jobs(record_expires_at,id) where completed_at is not null`.execute(
    db,
  );
  await sql`create index jobs_cleanup on jobs(cleanup_deadline,id) where remote_status='pending'`.execute(
    db,
  );
  await sql`create unique index jobs_task_identity on jobs(provider_registration_id,account_key,task_id) where task_id is not null`.execute(
    db,
  );
  await sql`create unique index jobs_callback_identity on jobs(callback_correlation) where callback_correlation is not null`.execute(
    db,
  );
  await sql`create index jobs_active_versions on jobs(capability_id,capability_version) where completed_at is null`.execute(
    db,
  );
  await sql`create index jobs_owner_listing on jobs(owner_id,submitted_at,id)`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table job_payloads`.execute(db);
  await sql`drop table jobs`.execute(db);
}
