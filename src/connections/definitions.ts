import { writeAudit } from "../persistence/audit.ts";
import {
  type Db,
  isUniqueViolation,
  type Queryable,
  type Tx,
  transaction,
} from "../persistence/database.ts";
import { bumpRevision, currentRevision } from "../persistence/revision.ts";
import type { Clock } from "../platform/clock.ts";
import { invalid, notFound, ServiceError } from "../platform/errors.ts";
import type { ProviderTypes } from "./provider-types.ts";
import type { ConnectionDefinition, DefinitionView, SecretField } from "./types.ts";
import {
  type DefinitionInput,
  IN_PLACE_FIELDS,
  unknownKeyErrors,
  validateDefinition,
} from "./validation.ts";

/** How often a replica reads the installation revision before trusting its cached definitions. */
export const REVISION_CHECK_MS = 1000;

export function definitionFromRow(row: {
  id: string;
  display_name: string;
  type: string;
  ownership: "shared" | "personal";
  api_hosts: string[];
  authorization_endpoint: string | null;
  token_endpoint: string | null;
  client_id: string | null;
  token_authentication: "basic" | "post" | null;
  scopes: string[];
  preset_options: Record<string, unknown>;
  credential_placement: ConnectionDefinition["credentialPlacement"];
  audience: string[];
  reauthorization_interval: number | null;
  private_hosts: boolean;
  enabled: boolean;
  retired: boolean;
  generation: number;
}): ConnectionDefinition {
  return {
    id: row.id,
    displayName: row.display_name,
    type: row.type,
    ownership: row.ownership,
    apiHosts: row.api_hosts,
    ...(row.authorization_endpoint ? { authorizationEndpoint: row.authorization_endpoint } : {}),
    ...(row.token_endpoint ? { tokenEndpoint: row.token_endpoint } : {}),
    ...(row.client_id ? { clientId: row.client_id } : {}),
    ...(row.token_authentication ? { tokenAuthentication: row.token_authentication } : {}),
    scopes: row.scopes,
    presetOptions: row.preset_options,
    credentialPlacement: row.credential_placement,
    audience: row.audience,
    ...(row.reauthorization_interval !== null
      ? { reauthorizationInterval: row.reauthorization_interval }
      : {}),
    privateHosts: row.private_hosts,
    enabled: row.enabled,
    retired: row.retired,
    generation: row.generation,
  };
}

function columns(d: DefinitionInput) {
  return {
    display_name: d.displayName,
    type: d.type,
    ownership: d.ownership,
    api_hosts: JSON.stringify(d.apiHosts),
    authorization_endpoint: d.authorizationEndpoint ?? null,
    token_endpoint: d.tokenEndpoint ?? null,
    client_id: d.clientId ?? null,
    token_authentication: d.tokenAuthentication ?? null,
    scopes: JSON.stringify(d.scopes),
    preset_options: JSON.stringify(d.presetOptions),
    credential_placement: JSON.stringify(d.credentialPlacement),
    audience: JSON.stringify(d.audience),
    reauthorization_interval: d.reauthorizationInterval ?? null,
    private_hosts: d.privateHosts,
    enabled: d.enabled,
  };
}

/** A stored definition as operator input, without values the type fills in itself. */
function inputOf(d: ConnectionDefinition, types: ProviderTypes): Record<string, unknown> {
  const { generation: _g, retired: _r, credentialPlacement, ...rest } = d;
  return types.get(d.type)?.credentialless ? rest : { ...rest, credentialPlacement };
}

type Snapshot = {
  revision: bigint;
  checkedAt: number;
  byId: ReadonlyMap<string, ConnectionDefinition>;
};

export type RedefineResult = {
  definition: ConnectionDefinition;
  generation: number;
  connectionsEnded: number;
};

/**
 * Connection definitions: validated as a whole, written with the installation revision,
 * and cached per replica until the revision moves.
 */
export class DefinitionStore {
  readonly #db: Db;
  readonly #types: ProviderTypes;
  readonly #clock: Clock;
  #snapshot: Snapshot | undefined;
  #loading: Promise<Snapshot> | undefined;

  constructor(options: { db: Db; types: ProviderTypes; clock: Clock }) {
    this.#db = options.db;
    this.#types = options.types;
    this.#clock = options.clock;
  }

  get types(): ProviderTypes {
    return this.#types;
  }

  /** Cached definitions, rechecked against the installation revision at most once per second. */
  async current(
    options: { force?: boolean } = {},
  ): Promise<ReadonlyMap<string, ConnectionDefinition>> {
    const snapshot = this.#snapshot;
    const now = this.#clock.now().getTime();
    if (snapshot && !options.force && now - snapshot.checkedAt < REVISION_CHECK_MS)
      return snapshot.byId;
    if (snapshot && !options.force) {
      const revision = await currentRevision(this.#db);
      if (revision === snapshot.revision) {
        this.#snapshot = { ...snapshot, checkedAt: now };
        return snapshot.byId;
      }
    }
    return (await this.#reload()).byId;
  }

  /** A write on this replica is visible to its next read without waiting for the revision check. */
  #invalidate(): void {
    if (this.#snapshot) this.#snapshot = { ...this.#snapshot, checkedAt: Number.NEGATIVE_INFINITY };
  }

  async #reload(): Promise<Snapshot> {
    this.#loading ??= (async () => {
      try {
        const loaded = await this.#db
          .transaction()
          .setIsolationLevel("repeatable read")
          .execute(async (tx) => {
            const revision = await currentRevision(tx);
            const rows = await tx.selectFrom("definitions").selectAll().execute();
            return { revision, rows };
          });
        const snapshot: Snapshot = {
          revision: loaded.revision,
          checkedAt: this.#clock.now().getTime(),
          byId: new Map(loaded.rows.map((row) => [row.id, definitionFromRow(row)])),
        };
        this.#snapshot = snapshot;
        return snapshot;
      } finally {
        this.#loading = undefined;
      }
    })();
    return await this.#loading;
  }

  async get(id: string): Promise<ConnectionDefinition | undefined> {
    return (await this.current()).get(id);
  }

  async #siteIds(db: Queryable): Promise<Set<string>> {
    return new Set((await db.selectFrom("trusted_sites").select("id").execute()).map((r) => r.id));
  }

  /** Every definition with secret status, including disabled and retired. Reads Postgres directly. */
  async listForOperators(): Promise<DefinitionView[]> {
    const rows = await this.#db.selectFrom("definitions").selectAll().orderBy("id").execute();
    const secrets = await this.#db
      .selectFrom("definition_secrets")
      .select(["definition_id", "field", "set_at"])
      .execute();
    return rows.map((row) =>
      this.#view(
        definitionFromRow(row),
        secrets.filter((s) => s.definition_id === row.id),
      ),
    );
  }

  async viewForOperators(id: string): Promise<DefinitionView> {
    const row = await this.#db
      .selectFrom("definitions")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) throw notFound("definition-not-found", `No definition named ${JSON.stringify(id)}`);
    const secrets = await this.#db
      .selectFrom("definition_secrets")
      .select(["definition_id", "field", "set_at"])
      .where("definition_id", "=", id)
      .execute();
    return this.#view(definitionFromRow(row), secrets);
  }

  #view(
    definition: ConnectionDefinition,
    secrets: { field: SecretField; set_at: Date }[],
  ): DefinitionView {
    const setAt: Partial<Record<SecretField, string>> = {};
    for (const s of secrets) setAt[s.field] = s.set_at.toISOString();
    return {
      ...definition,
      clientSecretSet: setAt.clientSecret !== undefined,
      signingSecretSet: setAt.signingSecret !== undefined,
      secretsSetAt: setAt,
    };
  }

  async create(actor: string, raw: unknown): Promise<DefinitionView> {
    const { definition, errors } = validateDefinition(raw, {
      types: this.#types,
      siteIds: await this.#siteIds(this.#db),
    });
    if (errors.length) throw invalid(errors, "The definition is invalid");
    try {
      await transaction(this.#db, async (tx) => {
        await tx
          .insertInto("definitions")
          .values({ id: definition.id, ...columns(definition), updated_at: this.#clock.now() })
          .execute();
        await bumpRevision(tx);
        await writeAudit(tx, {
          actor,
          action: "definition.create",
          target: definition.id,
          detail: { type: definition.type },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ServiceError(
          409,
          "definition-exists",
          `A definition named ${JSON.stringify(definition.id)} exists or existed`,
        );
      throw error;
    }
    this.#invalidate();
    return await this.viewForOperators(definition.id);
  }

  async #lockLive(tx: Tx, id: string): Promise<ConnectionDefinition> {
    const row = await tx
      .selectFrom("definitions")
      .selectAll()
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw notFound("definition-not-found", `No definition named ${JSON.stringify(id)}`);
    if (row.retired)
      throw new ServiceError(409, "definition-retired", "A retired definition cannot change");
    return definitionFromRow(row);
  }

  /** Changes in-place fields. Existing connections are kept. */
  async patch(actor: string, id: string, raw: unknown): Promise<DefinitionView> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw invalid([{ path: "", rule: "type:object" }]);
    const changes = raw as Record<string, unknown>;
    const keyErrors = unknownKeyErrors(changes, IN_PLACE_FIELDS);
    if (keyErrors.length) throw invalid(keyErrors, "Some fields cannot change in place");
    await transaction(this.#db, async (tx) => {
      const existing = await this.#lockLive(tx, id);
      const merged = { ...inputOf(existing, this.#types), ...changes };
      if (changes.reauthorizationInterval === null) delete merged.reauthorizationInterval;
      const { definition, errors } = validateDefinition(merged, {
        types: this.#types,
        siteIds: await this.#siteIds(tx),
      });
      if (errors.length) throw invalid(errors, "The definition is invalid");
      await tx
        .updateTable("definitions")
        .set({ ...columns(definition), updated_at: this.#clock.now() })
        .where("id", "=", id)
        .execute();
      await bumpRevision(tx);
      await writeAudit(tx, {
        actor,
        action: "definition.update",
        target: id,
        detail: { fields: Object.keys(changes) },
      });
    });
    this.#invalidate();
    return await this.viewForOperators(id);
  }

  /**
   * Redefines a definition: one transaction increments the generation, ends every connection of
   * earlier generations, deletes their credentials and records why. The ID stays the same.
   */
  async redefine(
    actor: string,
    id: string,
    raw: unknown,
  ): Promise<RedefineResult & { view: DefinitionView }> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw invalid([{ path: "", rule: "type:object" }]);
    const body = raw as Record<string, unknown>;
    if (body.id !== undefined && body.id !== id)
      throw invalid([{ path: "id", rule: "matches-path" }]);
    const result = await transaction(this.#db, async (tx) => {
      const existing = await this.#lockLive(tx, id);
      const { definition, errors } = validateDefinition(
        { ...body, id },
        { types: this.#types, siteIds: await this.#siteIds(tx) },
      );
      if (errors.length) throw invalid(errors, "The definition is invalid");
      const generation = existing.generation + 1;
      const now = this.#clock.now();
      await tx
        .updateTable("definitions")
        .set({ ...columns(definition), generation, updated_at: now })
        .where("id", "=", id)
        .execute();
      const connectionsEnded = await endConnections(tx, id, "redefined", now);
      await failPendingConnects(tx, id, "definition-changed");
      await bumpRevision(tx);
      await writeAudit(tx, {
        actor,
        action: "definition.redefine",
        target: id,
        detail: { generation, connectionsEnded, type: definition.type },
      });
      return { generation, connectionsEnded };
    });
    this.#invalidate();
    const view = await this.viewForOperators(id);
    return { definition: view, view, ...result };
  }

  /** Retires a definition: disables it, ends every connection, deletes credentials and secrets, keeps history. */
  async retire(
    actor: string,
    id: string,
  ): Promise<{ view: DefinitionView; connectionsEnded: number }> {
    const connectionsEnded = await transaction(this.#db, async (tx) => {
      await this.#lockLive(tx, id);
      const now = this.#clock.now();
      await tx
        .updateTable("definitions")
        .set({ enabled: false, retired: true, retired_at: now, updated_at: now })
        .where("id", "=", id)
        .execute();
      const ended = await endConnections(tx, id, "retired", now);
      await tx.deleteFrom("definition_secrets").where("definition_id", "=", id).execute();
      await tx
        .updateTable("secret_links")
        .set({ used_at: now })
        .where("definition_id", "=", id)
        .where("used_at", "is", null)
        .execute();
      await failPendingConnects(tx, id, "definition-changed");
      await bumpRevision(tx);
      await writeAudit(tx, {
        actor,
        action: "definition.retire",
        target: id,
        detail: { connectionsEnded: ended },
      });
      return ended;
    });
    this.#invalidate();
    return { view: await this.viewForOperators(id), connectionsEnded };
  }
}

/** Ends every live connection of a definition and deletes its credential. Returns how many ended. */
async function endConnections(
  tx: Tx,
  definitionId: string,
  reason: string,
  now: Date,
): Promise<number> {
  const ended = await tx
    .updateTable("connections")
    .set({
      status: "disconnected",
      sealed: null,
      disconnected_at: now,
      disconnect_reason: reason,
      updated_at: now,
    })
    .where("definition_id", "=", definitionId)
    .where("status", "<>", "disconnected")
    .executeTakeFirst();
  return Number(ended.numUpdatedRows);
}

async function failPendingConnects(tx: Tx, definitionId: string, failure: string): Promise<void> {
  await tx
    .updateTable("connect_transactions")
    // The state hash stays so the callback can report why the transaction ended.
    .set({ status: "failed", failure, pkce_verifier: null })
    .where("definition_id", "=", definitionId)
    .where("status", "=", "pending")
    .execute();
}
