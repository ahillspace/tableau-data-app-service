import type pg from "pg";
import { identifier } from "./postgres.ts";

const storageSchema = `
create schema storage_control;
create schema tdas;
revoke all on schema storage_control, tdas from public;

create table storage_control.installation (version integer primary key);
insert into storage_control.installation values (1);
create table storage_control.creator_sites (trusted_site_id uuid primary key);
create table storage_control.workspaces (
  id uuid primary key,
  namespace name unique not null,
  model name unique not null,
  reader name unique not null,
  editor name unique not null,
  credentials jsonb not null,
  journal_proof bytea not null,
  home_deployment text not null,
  home_site text not null,
  owner_id uuid not null,
  creator_id uuid not null,
  creation_key text not null,
  creation_digest text not null,
  label text not null,
  attribution jsonb,
  state text not null default 'active' check (state in ('active', 'suspended', 'archived', 'retired')),
  revision int not null default 0,
  access_version int not null default 0,
  site_access text check (site_access in ('read', 'edit')),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  purged_at timestamptz,
  unique (creator_id, creation_key)
);
create table storage_control.grants (
  workspace_id uuid not null references storage_control.workspaces(id),
  identity_id uuid not null,
  access text not null check (access in ('read', 'edit')),
  primary key (workspace_id, identity_id)
);
create table storage_control.migrations (
  workspace_id uuid not null references storage_control.workspaces(id),
  migration_id text not null,
  revision int not null,
  predecessor int not null,
  checksum text not null,
  actor_id uuid not null,
  applied_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (workspace_id, migration_id),
  unique (workspace_id, revision)
);
create table storage_control.audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default pg_catalog.clock_timestamp(),
  actor_id uuid not null,
  action text not null,
  target uuid not null,
  detail jsonb not null
);

create function tdas.actor_id() returns uuid
language sql stable set search_path = pg_catalog
as $$ select nullif(pg_catalog.current_setting('tdas.actor_id', true), '')::uuid $$;

create function storage_control.workspace_lock_key(workspace uuid) returns bigint
language sql immutable set search_path = pg_catalog
as $$ select pg_catalog.hashtextextended(workspace::text, 7147460391270::bigint) $$;

-- One shared lease per scoped transaction lets an operator drain all API replicas.
-- Derive the key from the true login so this helper cannot acquire a peer lease.
create function storage_control.enter_workspace() returns boolean
language plpgsql security definer set search_path = pg_catalog
as $$
declare workspace uuid;
begin
  select id into workspace from storage_control.workspaces w where w.state = 'active'
    and session_user in (w.model, w.reader, w.editor);
  if not found then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock_shared(storage_control.workspace_lock_key(workspace));
  return exists (select from storage_control.workspaces w where w.id = workspace and w.state = 'active');
end $$;

-- The verifier is passed as a protocol value by the gateway, never via a SQL setting
-- or text that a workspace author could inspect. Both checks also bind to the true login.
create function storage_control.migration_check(workspace uuid, actor uuid, proof text,
  migration text, predecessor_revision int, digest text) returns int
language plpgsql security definer set search_path = pg_catalog
as $$
declare
  current_workspace storage_control.workspaces;
  previous storage_control.migrations;
begin
  select * into current_workspace from storage_control.workspaces w
    where w.id = workspace and w.model = session_user and w.owner_id = actor
      and w.journal_proof = pg_catalog.sha256(pg_catalog.convert_to(proof, 'UTF8'))
      and w.state = 'active'
    for update;
  if not found then
    raise exception using errcode = 'TD001', message = 'Workspace migration is unavailable';
  end if;
  select * into previous from storage_control.migrations m
    where m.workspace_id = workspace and m.migration_id = migration;
  if found then
    if previous.checksum <> digest or previous.predecessor <> predecessor_revision then
      raise exception using errcode = 'TD002', message = 'Migration ID has different input';
    end if;
    return previous.revision;
  end if;
  if current_workspace.revision <> predecessor_revision then
    raise exception using errcode = 'TD003', message = 'Migration predecessor is stale';
  end if;
  return null;
end $$;

create function storage_control.migration_record(workspace uuid, actor uuid, proof text,
  migration text, predecessor_revision int, digest text) returns int
language plpgsql security definer set search_path = pg_catalog
as $$
declare
  revision_number int;
begin
  revision_number := storage_control.migration_check(workspace, actor, proof,
    migration, predecessor_revision, digest);
  if revision_number is not null then return revision_number; end if;
  update storage_control.workspaces w set revision = w.revision + 1 where w.id = workspace
    returning revision into revision_number;
  insert into storage_control.migrations
    (workspace_id, migration_id, revision, predecessor, checksum, actor_id)
    values (workspace, migration, revision_number, predecessor_revision, digest, actor);
  return revision_number;
end $$;

revoke execute on all functions in schema storage_control, tdas from public;
`;

/** Fixed installation work, run explicitly against a fresh database owned by the provisioner. */
export async function installStorage(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      await client.query("select pg_catalog.pg_advisory_xact_lock(872616786330624::bigint)");
      const {
        rows: [db],
      } = await client.query<{
        name: string;
        allowed: boolean;
        installed: boolean;
        empty: boolean;
      }>(`select d.datname as name,
        current_setting('server_version_num')::integer >= 160000
          and d.datdba = r.oid and r.rolcreaterole and not r.rolsuper
          and not r.rolcreatedb and not r.rolreplication and not r.rolbypassrls as allowed,
        to_regclass('storage_control.installation') is not null as installed,
        not exists (select from pg_namespace where nspname not in ('pg_catalog', 'pg_toast',
          'information_schema', 'public')) and
        not exists (select from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public') and
        not exists (select from pg_extension where extname <> 'plpgsql') as empty
        from pg_database d join pg_roles r on r.rolname = current_user
        where d.datname = current_database()`);
      if (!db?.allowed)
        throw new Error("Use the dedicated PostgreSQL 16+ Storage database owner with CREATEROLE");
      if (!db.installed) {
        if (!db.empty) throw new Error("Storage installation requires a fresh dedicated database");
        await client.query(`revoke all on database ${identifier(db.name)} from public;
          revoke all on schema public from public`);
        await client.query(storageSchema);
      }
      await assertStorageReady(client);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    client.release();
  }
}

export async function assertStorageReady(db: Pick<pg.PoolClient, "query">): Promise<void> {
  const {
    rows: [status],
  } = await db.query<{ ready: boolean }>(`select exists (
    select from storage_control.installation where version = 1
  ) and exists (
    select from pg_database d join pg_roles r on r.rolname = current_user
    where d.datname = current_database() and d.datdba = r.oid and r.rolcreaterole
      and not r.rolsuper and not r.rolcreatedb and not r.rolreplication and not r.rolbypassrls
      and not exists (select from pg_catalog.aclexplode(coalesce(d.datacl, acldefault('d',d.datdba)))
        where grantee = 0)
  ) and not exists (select from pg_extension where extname <> 'plpgsql')
    and not exists (select from pg_namespace n, lateral aclexplode(coalesce(n.nspacl, acldefault('n',n.nspowner))) a
      where n.nspname in ('public', 'tdas', 'storage_control') and a.grantee=0) as ready`);
  if (!status?.ready)
    throw new Error("Check the Storage database privileges, extensions and installed schema");
}
