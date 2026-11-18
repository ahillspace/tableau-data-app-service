import type { Selectable } from "kysely";
import type { ConnectResult } from "../contracts/operator.ts";
import { isOperator } from "../identity/directory.ts";
import { actorOf, type Principal } from "../identity/types.ts";
import { writeAudit } from "../persistence/audit.ts";
import {
  type Db,
  isUniqueViolation,
  type Queryable,
  type Tx,
  transaction,
} from "../persistence/database.ts";
import { bumpRevision, currentRevision } from "../persistence/revision.ts";
import type { Database } from "../persistence/schema.ts";
import type { Clock } from "../platform/clock.ts";
import { invalid, notFound, ServiceError } from "../platform/errors.ts";
import { fieldErrors } from "../platform/validation.ts";
import { definitionSecretRecordId } from "../sealing/reseal.ts";
import type { Sealer } from "../sealing/sealer.ts";
import type { Extensions } from "./extensions.ts";
import { normalizeCredential, signingKey } from "./protocol.ts";
import {
  connectionNeedsAuthorization,
  readDefinitionSecret,
  replaceConnection,
  requiredApplicationSecret,
  SECRET_PURPOSE,
} from "./store.ts";
import {
  type ConnectionDefinition,
  type Definition,
  type DefinitionView,
  SECRET_FIELDS,
  type SecretField,
} from "./types.ts";
import {
  IN_PLACE_FIELDS,
  publicDefinition,
  secretWritesSchema,
  unknownKeyErrors,
  validateDefinition,
} from "./validation.ts";

export const REVISION_CHECK_MS = 1000;
export function definitionFromRow(row: Selectable<Database["definitions"]>): ConnectionDefinition {
  return {
    ...row.configuration,
    audience: row.audience,
    displayName: row.display_name,
    ownership: row.ownership,
    enabled: row.enabled,
    retired: row.retired,
    generation: row.generation,
    version: row.version,
    secretGeneration: row.secret_generation,
  };
}
function columns(d: Definition) {
  return {
    configuration: JSON.stringify(d),
    display_name: d.displayName,
    ownership: d.ownership,
    audience: JSON.stringify(d.audience),
    enabled: d.enabled,
  };
}
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw invalid([{ path: "", rule: "type:object" }]);
  return raw as Record<string, unknown>;
}
export function expectedVersion(raw: Record<string, unknown>): number {
  if (!Number.isSafeInteger(raw.expectedVersion) || (raw.expectedVersion as number) < 1)
    throw invalid([{ path: "expectedVersion", rule: "positive-integer" }]);
  return raw.expectedVersion as number;
}
function splitWrite(raw: Record<string, unknown>) {
  const { secrets, credential, expectedVersion: _v, ...definition } = raw;
  return { definition, secrets, credential };
}
export type RedefineResult = {
  definition: DefinitionView;
  view: DefinitionView;
  generation: number;
  connectionsEnded: number;
};
/** Atomic definition and secret custody. Definition-row locks precede every connection lock. */
export class DefinitionStore {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #sealer: Sealer;
  readonly extensions: Extensions;
  #snapshot:
    | { revision: bigint; checkedAt: number; definitions: Map<string, ConnectionDefinition> }
    | undefined;
  constructor(options: { db: Db; extensions: Extensions; sealer: Sealer; clock: Clock }) {
    this.#db = options.db;
    this.extensions = options.extensions;
    this.#sealer = options.sealer;
    this.#clock = options.clock;
  }
  async current(
    options: { force?: boolean } = {},
  ): Promise<ReadonlyMap<string, ConnectionDefinition>> {
    const now = this.#clock.now().getTime(),
      cached = this.#snapshot;
    if (!options.force && cached && now - cached.checkedAt < REVISION_CHECK_MS)
      return cached.definitions;
    const revision = await currentRevision(this.#db);
    if (!options.force && cached?.revision === revision) {
      cached.checkedAt = now;
      return cached.definitions;
    }
    const loaded = await this.#db
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (tx) => ({
        revision: await currentRevision(tx),
        rows: await tx.selectFrom("definitions").selectAll().execute(),
      }));
    const definitions = new Map(loaded.rows.map((row) => [row.id, definitionFromRow(row)]));
    this.#snapshot = { revision: loaded.revision, checkedAt: now, definitions };
    return definitions;
  }
  async get(id: string): Promise<ConnectionDefinition | undefined> {
    return (await this.current()).get(id);
  }
  async #sites(db: Queryable): Promise<Set<string>> {
    return new Set((await db.selectFrom("trusted_sites").select("id").execute()).map((r) => r.id));
  }
  async #validate(raw: unknown, tx: Queryable): Promise<Definition> {
    const parsed = validateDefinition(raw, { siteIds: await this.#sites(tx) });
    if (parsed.errors.length) throw invalid(parsed.errors, "The definition is invalid");
    return parsed.definition;
  }
  async #lock(tx: Tx, id: string, version: number): Promise<ConnectionDefinition> {
    const row = await tx
      .selectFrom("definitions")
      .selectAll()
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw notFound("definition-not-found", "No such definition");
    if (row.retired)
      throw new ServiceError(409, "definition-retired", "A retired definition cannot change");
    if (row.version !== version)
      throw new ServiceError(
        409,
        "definition-conflict",
        "The definition changed; reload it before submitting again",
      );
    return definitionFromRow(row);
  }
  async listForOperators(): Promise<DefinitionView[]> {
    return this.#db
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (tx) => {
        const rows = await tx.selectFrom("definitions").selectAll().orderBy("id").execute();
        return Promise.all(rows.map((row) => this.#view(tx, definitionFromRow(row))));
      });
  }
  async viewForOperators(id: string): Promise<DefinitionView> {
    return this.#db
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (tx) => {
        const row = await tx
          .selectFrom("definitions")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirst();
        if (!row) throw notFound("definition-not-found", "No such definition");
        return this.#view(tx, definitionFromRow(row));
      });
  }
  async #view(tx: Queryable, d: ConnectionDefinition): Promise<DefinitionView> {
    const rows = await tx
      .selectFrom("definition_secrets")
      .select(["field", "set_at"])
      .where("definition_id", "=", d.id)
      .execute();
    const secrets = Object.fromEntries(
      SECRET_FIELDS.map((field) => {
        const found = rows.find((r) => r.field === field);
        return [field, { set: !!found, setAt: found?.set_at.toISOString() ?? null }];
      }),
    ) as DefinitionView["secrets"];
    const connections = await tx
      .selectFrom("connections")
      .select(["status", "credential_set_at", "owner_identity_id", "authorized_at", "generation"])
      .where("definition_id", "=", d.id)
      .execute();
    const shared =
      d.ownership === "shared" && d.authentication.method !== "none"
        ? connections.find(
            (c) =>
              c.owner_identity_id === null &&
              c.generation === d.generation &&
              c.status !== "disconnected",
          )
        : undefined;
    const now = this.#clock.now();
    const credential = { set: !!shared, setAt: shared?.credential_set_at.toISOString() ?? null };
    const missing: string[] = [],
      actions: DefinitionView["setup"]["actions"] = [];
    const a = d.authentication;
    const required = requiredApplicationSecret(a);
    if (required && !secrets[required].set) missing.push(`secrets.${required}`);
    if (
      d.ownership === "shared" &&
      a.method !== "none" &&
      (!shared || connectionNeedsAuthorization(d, shared, now)) &&
      !missing.length
    )
      missing.push(a.method === "client_credentials" ? "authorization" : "credential");
    if (missing.some((p) => p.startsWith("secrets."))) actions.push("set-secrets");
    if (d.ownership === "shared" && ["authorization_code", "client_credentials"].includes(a.method))
      actions.push("connect");
    if (
      d.ownership === "shared" &&
      ["static", "jwt_bearer", "signed_jwt_direct"].includes(a.method)
    )
      actions.push("set-credential");
    return {
      ...publicDefinition(d),
      retired: d.retired,
      generation: d.generation,
      version: d.version,
      secrets,
      credential,
      setup: {
        state: d.retired
          ? "retired"
          : !d.enabled
            ? "disabled"
            : missing.length
              ? "needs-setup"
              : "ready",
        missing,
        actions,
      },
      connectionCounts: {
        connected: connections.filter(
          (c) => c.status === "connected" && !connectionNeedsAuthorization(d, c, now),
        ).length,
        needsAuthorization: connections.filter((c) => connectionNeedsAuthorization(d, c, now))
          .length,
        disconnected: connections.filter((c) => c.status === "disconnected").length,
      },
    };
  }
  async #writeSecrets(
    tx: Tx,
    d: ConnectionDefinition,
    write: ReturnType<typeof splitWrite>,
    actor: string,
  ): Promise<void> {
    const parsed = secretWritesSchema.safeParse(write.secrets === undefined ? {} : write.secrets);
    if (!parsed.success) throw invalid(fieldErrors(parsed.error, "secrets"));
    const auth = d.authentication;
    const credential =
      write.credential === undefined || write.credential === null
        ? write.credential
        : normalizeCredential(d, write.credential);
    if (write.credential !== undefined && (d.ownership !== "shared" || auth.method === "none"))
      throw invalid([{ path: "credential", rule: "shared-credential-only" }]);
    for (const field of SECRET_FIELDS) {
      const value = parsed.data[field];
      if (value === undefined) continue;
      if (value !== null) {
        if (
          field === "clientSecret" &&
          (!("clientAuthentication" in auth) ||
            !["client_secret_basic", "client_secret_post"].includes(
              auth.clientAuthentication.method,
            ))
        )
          throw invalid([{ path: `secrets.${field}`, rule: "not-used-by-method" }]);
        if (field === "signingPrivateKey") {
          if (
            !("clientAuthentication" in auth) ||
            auth.clientAuthentication.method !== "private_key_jwt"
          )
            throw invalid([{ path: `secrets.${field}`, rule: "not-used-by-method" }]);
          try {
            signingKey(value, auth.clientAuthentication.jwt.algorithm);
          } catch {
            throw invalid([{ path: `secrets.${field}`, rule: "supported-signing-key" }]);
          }
        }
        if (field === "signingSecret" && !d.webhook)
          throw invalid([{ path: `secrets.${field}`, rule: "webhook-not-configured" }]);
      }
    }
    // All inputs validate before the first write; the caller transaction also protects rollback.
    const changed = SECRET_FIELDS.filter((field) => parsed.data[field] !== undefined);
    const now = this.#clock.now();
    for (const field of changed) {
      const value = parsed.data[field];
      if (value === null)
        await tx
          .deleteFrom("definition_secrets")
          .where("definition_id", "=", d.id)
          .where("field", "=", field)
          .execute();
      else {
        const sealed = JSON.stringify(
          this.#sealer.seal(
            SECRET_PURPOSE[field],
            definitionSecretRecordId(d.id, field),
            value as string,
          ),
        );
        await tx
          .insertInto("definition_secrets")
          .values({ definition_id: d.id, field, sealed, set_at: now })
          .onConflict((oc) =>
            oc.columns(["definition_id", "field"]).doUpdateSet({ sealed, set_at: now }),
          )
          .execute();
      }
    }
    if (credential === null) await endConnections(tx, d.id, "credential-cleared", now);
    else if (credential !== undefined) {
      const existing = await tx
        .selectFrom("connections")
        .select(["id", "credential_generation"])
        .where("definition_id", "=", d.id)
        .where("owner_identity_id", "is", null)
        .where("status", "<>", "disconnected")
        .forUpdate()
        .executeTakeFirst();
      if (existing)
        await tx
          .updateTable("connections")
          .set({
            sealed: JSON.stringify(
              this.#sealer.seal("credential", existing.id, JSON.stringify({ input: credential })),
            ),
            credential_generation: existing.credential_generation + 1,
            credential_set_at: now,
            credential_expires_at: null,
            status: "connected",
            authorized_at: now,
            updated_at: now,
            account: null,
            account_name: null,
          })
          .where("id", "=", existing.id)
          .execute();
      else
        await replaceConnection(tx, this.#sealer, {
          definition: d,
          ownerIdentityId: null,
          credential: { input: credential },
          account: null,
          scopes: d.scopes,
          now,
        });
    }
    if (changed.length)
      await tx
        .updateTable("definitions")
        .set({ secret_generation: d.secretGeneration + 1 })
        .where("id", "=", d.id)
        .execute();
    if (changed.length || write.credential !== undefined)
      await writeAudit(tx, {
        actor,
        action: "definition.secret",
        target: d.id,
        detail: { fields: changed, credentialChanged: write.credential !== undefined },
      });
  }
  async #initializeMachine(tx: Tx, d: ConnectionDefinition): Promise<string | undefined> {
    if (d.authentication.method !== "client_credentials") return;
    const required = requiredApplicationSecret(d.authentication);
    if (required && !(await readDefinitionSecret(tx, this.#sealer, d.id, required))) return;
    return replaceConnection(tx, this.#sealer, {
      definition: d,
      ownerIdentityId: null,
      credential: {},
      account: null,
      scopes: d.scopes,
      now: this.#clock.now(),
    });
  }
  async connectMachine(
    principal: Principal,
    id: string,
  ): Promise<Extract<ConnectResult, { kind: "connected" }>> {
    return transaction(this.#db, async (tx) => {
      const row = await tx
        .selectFrom("definitions")
        .selectAll()
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw notFound("definition-not-found", "No such definition");
      if (!row.enabled || row.retired)
        throw new ServiceError(403, "definition-disabled", "The definition is disabled");
      const d = definitionFromRow(row);
      if (d.ownership !== "shared")
        throw new ServiceError(
          409,
          "personal-definition",
          "The definition uses personal connections",
        );
      if (d.authentication.method !== "client_credentials")
        throw new ServiceError(
          409,
          "connect-not-supported",
          "The definition does not use machine authorization",
        );
      if (
        principal.kind !== "operator" ||
        !(await isOperator(tx, principal.identity, { hold: true }))
      )
        throw new ServiceError(403, "operator-required", "Operator access is required");
      const connectionId = await this.#initializeMachine(tx, d);
      if (!connectionId)
        throw invalid([
          { path: `secrets.${requiredApplicationSecret(d.authentication)}`, rule: "required" },
        ]);
      await writeAudit(tx, { actor: actorOf(principal), action: "connection.connect", target: id });
      return { kind: "connected", definitionId: id, connectionId };
    });
  }
  async create(actor: string, raw: unknown): Promise<DefinitionView> {
    const input = object(raw),
      write = splitWrite(input);
    if (input.expectedVersion !== undefined)
      throw invalid([{ path: "expectedVersion", rule: "not-used-on-create" }]);
    const d = await this.#validate(write.definition, this.#db);
    try {
      await transaction(this.#db, async (tx) => {
        const row = await tx
          .insertInto("definitions")
          .values({ id: d.id, ...columns(d), updated_at: this.#clock.now() })
          .returningAll()
          .executeTakeFirstOrThrow();
        const created = definitionFromRow(row);
        await this.#writeSecrets(tx, created, write, actor);
        if (write.credential !== null) await this.#initializeMachine(tx, created);
        await bumpRevision(tx);
        await writeAudit(tx, {
          actor,
          action: "definition.create",
          target: d.id,
          detail: { method: d.authentication.method },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ServiceError(409, "definition-exists", "That definition ID exists or existed");
      throw error;
    }
    this.#snapshot = undefined;
    return this.viewForOperators(d.id);
  }
  async patch(actor: string, id: string, raw: unknown): Promise<DefinitionView> {
    const input = object(raw),
      version = expectedVersion(input),
      write = splitWrite(input);
    const errors = unknownKeyErrors(input, IN_PLACE_FIELDS);
    if (errors.length) throw invalid(errors);
    await transaction(this.#db, async (tx) => {
      const current = await this.#lock(tx, id, version);
      const merged = { ...publicDefinition(current), ...write.definition };
      if (merged.reauthorizationInterval === null) delete merged.reauthorizationInterval;
      const d = await this.#validate(merged, tx);
      await this.#writeSecrets(tx, { ...current, ...d }, write, actor);
      await tx
        .updateTable("definitions")
        .set({ ...columns(d), version: version + 1, updated_at: this.#clock.now() })
        .where("id", "=", id)
        .execute();
      await bumpRevision(tx);
      await writeAudit(tx, { actor, action: "definition.update", target: id });
    });
    this.#snapshot = undefined;
    return this.viewForOperators(id);
  }
  async setSecrets(actor: string, id: string, raw: unknown): Promise<DefinitionView> {
    const input = object(raw);
    const errors = unknownKeyErrors(input, new Set(["expectedVersion", "secrets", "credential"]));
    if (errors.length) throw invalid(errors);
    if (
      input.credential === undefined &&
      (!input.secrets || typeof input.secrets !== "object" || !Object.keys(input.secrets).length)
    )
      throw invalid([{ path: "", rule: "secret-mutation-required" }]);
    return this.patch(actor, id, input);
  }
  async redefine(actor: string, id: string, raw: unknown): Promise<RedefineResult> {
    const input = object(raw),
      version = expectedVersion(input),
      write = splitWrite(input);
    if (write.definition.id !== undefined && write.definition.id !== id)
      throw invalid([{ path: "id", rule: "matches-path" }]);
    const result = await transaction(this.#db, async (tx) => {
      const existing = await this.#lock(tx, id, version),
        d = await this.#validate({ ...write.definition, id }, tx),
        now = this.#clock.now();
      const generation = existing.generation + 1;
      await tx
        .updateTable("definitions")
        .set({ ...columns(d), generation, version: version + 1, updated_at: now })
        .where("id", "=", id)
        .execute();
      const connectionsEnded = await endConnections(tx, id, "redefined", now);
      await failPendingConnects(tx, id);
      const redefined = { ...existing, ...d, generation };
      await this.#writeSecrets(tx, redefined, write, actor);
      if (write.credential !== null) await this.#initializeMachine(tx, redefined);
      await bumpRevision(tx);
      await writeAudit(tx, {
        actor,
        action: "definition.redefine",
        target: id,
        detail: { generation, connectionsEnded },
      });
      return { generation, connectionsEnded };
    });
    this.#snapshot = undefined;
    const view = await this.viewForOperators(id);
    return { definition: view, view, ...result };
  }
  async retire(
    actor: string,
    id: string,
    raw: unknown,
  ): Promise<{ view: DefinitionView; connectionsEnded: number }> {
    const version = expectedVersion(object(raw));
    const connectionsEnded = await transaction(this.#db, async (tx) => {
      await this.#lock(tx, id, version);
      const now = this.#clock.now();
      await tx
        .updateTable("definitions")
        .set({
          enabled: false,
          retired: true,
          version: version + 1,
          retired_at: now,
          updated_at: now,
        })
        .where("id", "=", id)
        .execute();
      const ended = await endConnections(tx, id, "retired", now);
      await tx.deleteFrom("definition_secrets").where("definition_id", "=", id).execute();
      await failPendingConnects(tx, id);
      await bumpRevision(tx);
      await writeAudit(tx, {
        actor,
        action: "definition.retire",
        target: id,
        detail: { connectionsEnded: ended },
      });
      return ended;
    });
    this.#snapshot = undefined;
    return { view: await this.viewForOperators(id), connectionsEnded };
  }
}
export async function endConnections(
  tx: Tx,
  id: string,
  reason: string,
  now: Date,
): Promise<number> {
  const result = await tx
    .updateTable("connections")
    .set({
      status: "disconnected",
      sealed: null,
      disconnected_at: now,
      disconnect_reason: reason,
      updated_at: now,
    })
    .where("definition_id", "=", id)
    .where("status", "<>", "disconnected")
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}
async function failPendingConnects(tx: Tx, id: string): Promise<void> {
  await tx
    .updateTable("connect_transactions")
    .set({ status: "failed", failure: "definition-changed", pkce_verifier: null })
    .where("definition_id", "=", id)
    .where("status", "=", "pending")
    .execute();
}
