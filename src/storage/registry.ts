import { createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { Principal } from "../identity/types.ts";
import type { SealedJson } from "../persistence/schema.ts";
import { notFound, ServiceError } from "../platform/errors.ts";
import type { Sealer } from "../sealing/sealer.ts";
import { identifier as ident, literal } from "./postgres.ts";

export type DataAccess = "read" | "edit";
export type Access = "owner" | DataAccess;
export type State = "active" | "suspended" | "archived" | "retired";
export type Role = "model" | "reader" | "editor";
export type Grant = { identityId: string; access: DataAccess };
export type CreateWorkspace = {
  label: string;
  creationKey: string;
  attribution?: { appId?: string | undefined; workbook?: string | undefined } | undefined;
};
export type Workspace = {
  id: string;
  namespace: string;
  model: string;
  reader: string;
  editor: string;
  credentials: Record<Role | "proof", SealedJson>;
  home_deployment: string;
  home_site: string;
  owner_id: string;
  creation_digest: string;
  label: string;
  attribution: CreateWorkspace["attribution"] | null;
  state: State;
  revision: number;
  access_version: number;
  site_access: DataAccess | null;
  access: Access | null;
  purged_at: Date | null;
};

type Queryer = Pick<pg.PoolClient, "query">;
export const workspaceNotFound = () =>
  notFound("storage-workspace-not-found", "No accessible storage workspace");
const conflict = (message: string) => new ServiceError(409, "storage-conflict", message);
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const authorityJoin = `select w.*, case
  when w.owner_id = $3::uuid then 'owner'
  when w.state <> 'active' then null
  when g.access = 'edit' or w.site_access = 'edit' then 'edit'
  else coalesce(g.access, w.site_access) end as access
  from storage_control.workspaces w left join storage_control.grants g
  on g.workspace_id = w.id and g.identity_id = $3::uuid
  where w.home_deployment = $1 and w.home_site = $2 and w.state <> 'retired'`;

function subject(principal: Principal) {
  return [principal.identity.deploymentId, principal.identity.siteId, principal.identityId];
}

async function transaction<T>(
  pool: pg.Pool,
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let clean = false;
  try {
    await client.query("begin");
    try {
      const result = await run(client);
      await client.query("commit");
      clean = true;
      return result;
    } catch (error) {
      await client.query("rollback");
      clean = true;
      throw error;
    }
  } finally {
    client.release(!clean);
  }
}

function audit(db: Queryer, actor: Principal, action: string, target: string, detail = {}) {
  return db.query(
    `insert into storage_control.audit (actor_id, action, target, detail)
    values ($1, $2, $3, $4)`,
    [actor.identityId, action, target, detail],
  );
}

/** PostgreSQL can accept a SCRAM verifier in CREATE ROLE, keeping plaintext out of SQL logs. */
function scram(password: string): string {
  const salt = randomBytes(16);
  const rounds = 4096;
  const key = pbkdf2Sync(password, salt, rounds, 32, "sha256");
  const hmac = (label: string) => createHmac("sha256", key).update(label).digest();
  const stored = createHash("sha256").update(hmac("Client Key")).digest("base64");
  const server = hmac("Server Key").toString("base64");
  return `SCRAM-SHA-256$${rounds}:${salt.toString("base64")}$${stored}:${server}`;
}

async function provision(
  db: Queryer,
  workspace: Pick<Workspace, "model" | "reader" | "editor" | "namespace">,
  passwords: Record<Role, string>,
  database: string,
) {
  const namespace = ident(workspace.namespace);
  const model = ident(workspace.model);
  const reader = ident(workspace.reader);
  const editor = ident(workspace.editor);
  for (const kind of ["model", "reader", "editor"] as const) {
    const role = ident(workspace[kind]);
    await db.query(
      `create role ${role} login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls password ${literal(scram(passwords[kind]))}`,
    );
  }
  await db.query(`create schema ${namespace};
    grant connect on database ${ident(database)} to ${model}, ${reader}, ${editor};
    grant usage on schema tdas to ${model}, ${reader}, ${editor};
    grant execute on function tdas.actor_id() to ${model}, ${reader}, ${editor};
    grant usage on schema ${namespace} to ${model}, ${reader}, ${editor};
    grant create on schema ${namespace} to ${model};
    grant usage on schema storage_control to ${model}, ${reader}, ${editor};
    grant execute on function storage_control.enter_workspace() to ${model}, ${reader}, ${editor};
    grant execute on function storage_control.migration_check(uuid,uuid,text,text,int,text),
      storage_control.migration_record(uuid,uuid,text,text,int,text) to ${model};
    grant ${model} to current_user with inherit false, set true;
    set local role ${model};
    alter default privileges in schema ${namespace} grant select on tables to ${reader};
    alter default privileges in schema ${namespace} grant select, insert, update, delete on tables to ${editor};
    alter default privileges in schema ${namespace} grant usage, select on sequences to ${editor};
    alter default privileges revoke execute on functions from public;
    reset role`);
}

export class Registry {
  readonly #pool: pg.Pool;
  readonly #url: URL;
  readonly #sealer: Sealer;
  constructor(pool: pg.Pool, url: URL, sealer: Sealer) {
    this.#pool = pool;
    this.#url = url;
    this.#sealer = sealer;
  }

  async canCreate(trustedSiteId: string, db: Queryer = this.#pool): Promise<boolean> {
    const { rowCount } = await db.query(
      "select from storage_control.creator_sites where trusted_site_id = $1",
      [trustedSiteId],
    );
    return rowCount === 1;
  }

  async list(principal: Principal): Promise<Workspace[]> {
    const { rows } = await this.#pool.query<Workspace>(
      `${authorityJoin} order by w.created_at, w.id`,
      subject(principal),
    );
    return rows.filter((workspace) => workspace.access);
  }

  async find(principal: Principal, id: string, db: Queryer = this.#pool): Promise<Workspace> {
    const {
      rows: [workspace],
    } = await db.query<Workspace>(`${authorityJoin} and w.id = $4`, [...subject(principal), id]);
    if (!workspace?.access) throw workspaceNotFound();
    return workspace;
  }

  async revision(id: string): Promise<number | undefined> {
    const { rows } = await this.#pool.query<{ revision: number }>(
      "select revision from storage_control.workspaces where id=$1",
      [id],
    );
    return rows[0]?.revision;
  }

  async create(principal: Principal, input: CreateWorkspace): Promise<Workspace> {
    const label = input.label;
    const creationDigest = digest(
      JSON.stringify([
        label,
        input.attribution?.appId ?? null,
        input.attribution?.workbook ?? null,
      ]),
    );
    return transaction(this.#pool, async (db) => {
      // The claimant's idempotency key spans every replica running against this installation.
      await db.query(
        "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
        [`tdas.storage.create:${principal.identityId}:${input.creationKey}`],
      );
      const {
        rows: [prior],
      } = await db.query<Pick<Workspace, "id" | "creation_digest">>(
        `select id, creation_digest
        from storage_control.workspaces where creator_id = $1 and creation_key = $2`,
        [principal.identityId, input.creationKey],
      );
      if (prior) {
        if (prior.creation_digest !== creationDigest)
          throw conflict("Creation key has different input");
        return this.find(principal, prior.id, db);
      }
      if (!(await this.canCreate(principal.trustedSiteId, db)))
        throw new ServiceError(
          403,
          "storage-create-disabled",
          "Workspace creation is disabled for this Tableau site",
        );
      const id = randomUUID();
      const namespace = `w_${id.replaceAll("-", "")}`;
      const model = `${namespace}_model`;
      const reader = `${namespace}_reader`;
      const editor = `${namespace}_editor`;
      const secret = () => randomBytes(32).toString("base64url");
      const passwords = { model: secret(), reader: secret(), editor: secret(), proof: secret() };
      const credentials = Object.fromEntries(
        Object.entries(passwords).map(([kind, value]) => [
          kind,
          this.#sealer.seal("storage-role", `${id}:${kind}`, value),
        ]),
      );
      const {
        rows: [database],
      } = await db.query<{ name: string }>("select current_database() as name");
      if (!database) throw new Error("Storage database is unavailable");
      await provision(db, { namespace, model, reader, editor }, passwords, database.name);
      await db.query(
        `insert into storage_control.workspaces
        (id, namespace, model, reader, editor, credentials, journal_proof, home_deployment,
         home_site, owner_id, creator_id, creation_key, creation_digest, label, attribution)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12, $13, $14)`,
        [
          id,
          namespace,
          model,
          reader,
          editor,
          credentials,
          Buffer.from(digest(passwords.proof), "hex"),
          ...subject(principal),
          input.creationKey,
          creationDigest,
          label,
          input.attribution ?? null,
        ],
      );
      await audit(db, principal, "workspace.create", id);
      return this.find(principal, id, db);
    });
  }

  secret(workspace: Workspace, kind: Role | "proof"): string {
    return this.#sealer.open(
      "storage-role",
      `${workspace.id}:${kind}`,
      workspace.credentials[kind],
    );
  }

  roleUrl(workspace: Workspace, role: Role): string {
    const url = new URL(this.#url);
    url.username = workspace[role];
    url.password = this.secret(workspace, role);
    return url.href;
  }

  async ownerDetails(workspace: Workspace) {
    const [{ rows: grants }, { rows: migrations }] = await Promise.all([
      this.#pool.query<Grant>(
        `select identity_id as "identityId", access from storage_control.grants
        where workspace_id = $1 order by identity_id`,
        [workspace.id],
      ),
      this.#pool.query(
        `select migration_id as id, revision, predecessor, checksum,
        actor_id as "actorId", applied_at as "appliedAt" from storage_control.migrations
        where workspace_id = $1 and revision <= $2 order by revision`,
        [workspace.id, workspace.revision],
      ),
    ]);
    return {
      namespace: workspace.namespace,
      roles: { reader: workspace.reader, editor: workspace.editor },
      accessVersion: workspace.access_version,
      siteAccess: workspace.site_access,
      grants,
      migrations,
    };
  }

  async setAccess(
    principal: Principal,
    id: string,
    input: { version: number; site: DataAccess | null; grants: Grant[] },
    validateGrants: (workspace: Workspace) => Promise<void>,
  ): Promise<Workspace> {
    return transaction(this.#pool, async (db) => {
      await db.query("select id from storage_control.workspaces where id = $1 for update", [id]);
      const workspace = await this.find(principal, id, db);
      owner(workspace);
      if (workspace.access_version !== input.version)
        throw conflict("Sharing changed. Reload the workspace before editing access.");
      await validateGrants(workspace);
      await db.query(
        `update storage_control.workspaces set site_access = $1, access_version = access_version + 1
        where id = $2`,
        [input.site, id],
      );
      await db.query("delete from storage_control.grants where workspace_id = $1", [id]);
      if (input.grants.length)
        await db.query(
          `insert into storage_control.grants (workspace_id, identity_id, access)
          select $1, x.id, x.access from unnest($2::uuid[], $3::text[]) x(id, access)`,
          [
            id,
            input.grants.map((grant) => grant.identityId),
            input.grants.map((grant) => grant.access),
          ],
        );
      await audit(db, principal, "workspace.access", id, {
        site: input.site,
        grants: input.grants,
      });
      return this.find(principal, id, db);
    });
  }

  async edit(
    principal: Principal,
    id: string,
    input: { label?: string | undefined; state?: "active" | "archived" | undefined },
  ): Promise<Workspace> {
    return transaction(this.#pool, async (db) => {
      await db.query("select id from storage_control.workspaces where id = $1 for update", [id]);
      const current = await this.find(principal, id, db);
      owner(current, false);
      if (current.state === "suspended")
        throw new ServiceError(409, "storage-workspace-suspended", "The workspace is suspended");
      await db.query(
        "update storage_control.workspaces set label=coalesce($1,label), state=coalesce($2,state) where id=$3",
        [input.label ?? null, input.state ?? null, id],
      );
      await audit(db, principal, "workspace.edit", id, input);
      return this.find(principal, id, db);
    });
  }

  async creatorSites() {
    const { rows } = await this.#pool.query<{ trusted_site_id: string }>(
      "select trusted_site_id from storage_control.creator_sites order by trusted_site_id",
    );
    return rows.map(({ trusted_site_id }) => trusted_site_id);
  }

  async setCreatorSite(operator: Principal, siteId: string, enabled: boolean) {
    return transaction(this.#pool, async (db) => {
      if (enabled)
        await db.query(
          "insert into storage_control.creator_sites values ($1) on conflict do nothing",
          [siteId],
        );
      else
        await db.query("delete from storage_control.creator_sites where trusted_site_id=$1", [
          siteId,
        ]);
      await audit(db, operator, "site.creation", siteId, { enabled });
      return { trustedSiteId: siteId, enabled };
    });
  }

  async operatorWorkspaces() {
    const { rows } = await this.#pool.query(`select id, label, home_deployment as "deploymentId",
      home_site as "siteId", owner_id as "ownerId", state, revision, created_at as "createdAt", purged_at as "purgedAt"
      from storage_control.workspaces order by created_at, id`);
    return rows;
  }

  async operate(
    principal: Principal,
    id: string,
    input: { state?: State | undefined; ownerId?: string | undefined },
    verify: (workspace: Workspace, ownerId: string | undefined) => Promise<void>,
  ) {
    return transaction(this.#pool, async (db) => {
      const {
        rows: [workspace],
      } = await db.query<Workspace>(
        "select * from storage_control.workspaces where id = $1 for update",
        [id],
      );
      if (!workspace) throw workspaceNotFound();
      if (workspace.state === "retired" && (input.state !== "retired" || input.ownerId))
        throw conflict("A retired workspace cannot be reopened");
      await verify(workspace, input.ownerId);
      const {
        rows: [changed],
      } = await db.query(
        `update storage_control.workspaces
        set state=coalesce($1,state), owner_id=coalesce($2,owner_id)
        where id=$3 returning id, label, state, owner_id as "ownerId", revision`,
        [input.state ?? null, input.ownerId ?? null, id],
      );
      await audit(db, principal, "workspace.operate", id, input);
      return changed;
    });
  }

  async purge(principal: Principal, id: string, verify: () => Promise<Principal>) {
    return transaction(this.#pool, async (db) => {
      await db.query(
        "select pg_catalog.pg_advisory_xact_lock(storage_control.workspace_lock_key($1))",
        [id],
      );
      const {
        rows: [w],
      } = await db.query<Workspace>(
        "select * from storage_control.workspaces where id=$1 for update",
        [id],
      );
      if (!w) throw workspaceNotFound();
      if ((await verify()).identityId !== principal.identityId)
        throw new ServiceError(403, "operator-required", "Operator access is required");
      if (w.state !== "retired") throw conflict("Retire the workspace before purging its data");
      if (w.purged_at) return { id, state: w.state, purgedAt: w.purged_at };
      const namespace = `w_${w.id.replaceAll("-", "")}`;
      const roles = [`${namespace}_model`, `${namespace}_reader`, `${namespace}_editor`];
      if (
        w.namespace !== namespace ||
        [w.model, w.reader, w.editor].some((role, i) => role !== roles[i])
      )
        throw conflict("Workspace role mappings do not match its recorded namespace");
      // Roles must own only objects in this schema. A default ACL belongs to the role itself.
      // PostgreSQL's RESTRICT then guards objects belonging to other roles that depend on ours.
      const {
        rows: [ownership],
      } = await db.query<{ outside: boolean }>(
        `with owned as (
        select d.* from pg_shdepend d join pg_roles r on r.oid=d.refobjid
        where d.refclassid='pg_authid'::regclass and d.deptype='o' and r.rolname=any($1::name[])
      ), this_db as (select oid from pg_database where datname=current_database()),
      local_objects as materialized (
        select o.* from owned o join this_db d on d.oid=o.dbid where o.classid <> 'pg_default_acl'::regclass
      )
      select exists (select from owned o where o.dbid <> (select oid from this_db))
        or exists (select from local_objects o,
          lateral pg_identify_object(o.classid,o.objid,0) obj where obj.schema is distinct from $2) as outside`,
        [roles, namespace],
      );
      if (ownership?.outside)
        throw conflict("A workspace role owns an object outside its schema; purge is blocked");
      const roleList = roles.map(ident).join(", ");
      // Remove the model defaults first so PostgreSQL does not revisit their grantees
      // while removing reader and editor grants from other objects.
      try {
        await db.query(`grant ${roleList} to current_user with inherit true;
          drop owned by ${ident(w.model)} restrict;
          drop owned by ${ident(w.reader)}, ${ident(w.editor)} restrict;
          drop schema ${ident(namespace)} restrict;
          drop role ${roleList}`);
      } catch (error) {
        if ((error as { code?: string }).code === "2BP01")
          throw conflict(
            "A PostgreSQL dependency prevents workspace purge; the database is unchanged",
          );
        throw error;
      }
      const {
        rows: [changed],
      } = await db.query(
        `update storage_control.workspaces set purged_at=clock_timestamp(),
        credentials='{}'::jsonb, journal_proof=''::bytea, site_access=null where id=$1
        returning id, state, purged_at as "purgedAt"`,
        [id],
      );
      await db.query("delete from storage_control.grants where workspace_id=$1", [id]);
      await audit(db, principal, "workspace.purge", id);
      return changed;
    });
  }
}

export function owner(workspace: Workspace, active = true): void {
  if (workspace.access !== "owner")
    throw new ServiceError(403, "storage-owner-required", "Workspace owner access is required");
  if (active) requireActive(workspace);
}

export function requireActive(workspace: Workspace): void {
  if (workspace.state !== "active")
    throw new ServiceError(409, "storage-workspace-inactive", "The workspace is inactive");
}
