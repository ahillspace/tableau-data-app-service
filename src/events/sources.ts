import { randomUUID } from "node:crypto";
import { type Selectable, sql, type Transaction } from "kysely";
import type {
  AccessContext,
  BackgroundAuthorityPort,
  CoreServices,
  OperationAuthority,
} from "../core-ports.js";
import type { CoreTransaction } from "../db/database.js";
import { ServiceError } from "../http/errors.js";
import { opaqueId } from "../public/schemas.js";
import type { EventSourcesTable, EventsDatabase, EventsDb } from "./schema.js";
import type { EventProvider, Source, SourcePublication } from "./types.js";

export class Sources {
  readonly db: EventsDb;
  constructor(
    readonly core: CoreServices,
    readonly providers: ReadonlyMap<string, EventProvider>,
  ) {
    this.db = core.db.withTables<Pick<EventsDatabase, "event_sources" | "event_source_audience">>();
  }

  context(source: Source): Record<string, unknown> {
    const bytes = this.core.secrets.open(source.private_context, {
      kind: "event-source",
      id: source.id,
      provider: source.provider_registration_id,
      revision: String(source.revision),
    });
    return JSON.parse(bytes.toString("utf8"));
  }
  seal(id: string, registration: string, revision: number, context: Record<string, unknown>) {
    return this.core.secrets.seal(Buffer.from(JSON.stringify(context)), {
      kind: "event-source",
      id,
      provider: registration,
      revision: String(revision),
    });
  }
  provider(registration: string): EventProvider {
    const provider = this.providers.get(registration);
    if (!provider) throw new ServiceError(404, "not-found", "Event source not found");
    return provider;
  }

  /** Native setup alone grants no audience: server provider verification publishes the association. */
  async associate(
    access: AccessContext,
    input: {
      providerRegistrationId: string;
      connectionId?: string;
      setup: "manual" | "app" | "service";
      inputs: Record<string, unknown>;
    },
  ): Promise<string> {
    opaqueId.parse(input.providerRegistrationId);
    const definition = this.provider(input.providerRegistrationId);
    const use = await this.core.connections.authorizeUse(
      access,
      input.providerRegistrationId,
      input.connectionId,
    );
    const scope = await this.core.connections.openScope(
      { source: "request", access },
      input.providerRegistrationId,
      use?.connectionId,
      AbortSignal.timeout(30000),
    );
    let publication: SourcePublication;
    try {
      publication = await definition.verifyAssociation(input.inputs, scope.context);
    } finally {
      await scope.dispose();
    }
    if (!publication.accountKey || publication.accountKey.length > 500)
      throw new Error("Invalid verified source account");
    const id = randomUUID();
    const needsCreate = input.setup === "service" && !!definition.hooks?.create;
    await this.db.transaction().execute(async (tx) => {
      await this.core.access.lockAuthority(tx, access, input.providerRegistrationId);
      await this.core.connections.lockBackground(tx, {
        access,
        providerRegistrationId: input.providerRegistrationId,
        ...(use
          ? { connectionId: use.connectionId, authorityGeneration: use.authorityGeneration }
          : {}),
        started: false,
        purpose: "event-source",
      });
      await tx
        .insertInto("event_sources")
        .values({
          id,
          provider_registration_id: input.providerRegistrationId,
          setup_kind: input.setup,
          owner_id: access.ownerId,
          setup_owner_id: access.ownerId,
          setup_app_id: access.appId,
          connection_id: use?.connectionId ?? null,
          authority_generation: use?.authorityGeneration ?? null,
          account_key: publication.accountKey,
          revision: 1,
          state: needsCreate ? "configured" : "active",
          verified: !needsCreate,
          private_context: this.seal(
            id,
            input.providerRegistrationId,
            1,
            publication.privateContext,
          ),
          provider_expires_at: publication.expiresAt ?? null,
          renew_after: needsCreate ? new Date() : (publication.renewAfter ?? null),
          claim_token: null,
          claim_incarnation: null,
          lease_until: null,
          operation: null,
          phase: null,
        })
        .execute();
    });
    return id;
  }

  async get(id: string): Promise<Source | undefined> {
    return this.db.selectFrom("event_sources").selectAll().where("id", "=", id).executeTakeFirst();
  }

  health(source: Source, now = new Date()): Source["state"] {
    if (
      source.state === "active" &&
      ((source.provider_expires_at && source.provider_expires_at <= now) ||
        (source.renew_after && source.renew_after <= now))
    )
      return "attention-required";
    return source.state;
  }

  /** Core calls while holding the original connection parent during disconnect/account replacement. */
  async retireConnection(
    transaction: CoreTransaction,
    connectionId: string,
    authorityGeneration: number,
  ): Promise<void> {
    const tx =
      transaction.withTables<Pick<EventsDatabase, "event_sources" | "event_source_audience">>();
    const sources = await tx
      .selectFrom("event_sources")
      .selectAll()
      .where("connection_id", "=", connectionId)
      .where("authority_generation", "=", authorityGeneration)
      .where("state", "!=", "retired")
      .orderBy("id")
      .forUpdate()
      .execute();
    for (const source of sources)
      await tx
        .updateTable("event_sources")
        .set({
          state: "retired",
          revision: source.revision + 1,
          private_context: this.seal(
            source.id,
            source.provider_registration_id,
            source.revision + 1,
            {},
          ),
          claim_token: null,
          claim_incarnation: null,
          lease_until: null,
          operation: null,
          phase: null,
          renew_after: null,
        })
        .where("id", "=", source.id)
        .execute();
  }

  /** Source-owned routing authority is always reread, independently of maintenance state. */
  async eligible(id: string, revision?: number): Promise<Source | undefined> {
    const source = await this.get(id);
    if (
      !source ||
      !source.verified ||
      !["active", "attention-required"].includes(source.state) ||
      (revision !== undefined && revision !== source.revision)
    )
      return;
    const registration = await this.db
      .selectFrom("provider_registrations")
      .select("enabled")
      .where("id", "=", source.provider_registration_id)
      .executeTakeFirst();
    if (!registration?.enabled) return;
    if (source.owner_id) {
      const owner = await this.db
        .selectFrom("owners as o")
        .innerJoin("tableau_sites as s", (j) =>
          j.onRef("s.deployment_id", "=", "o.deployment_id").onRef("s.site_id", "=", "o.site_id"),
        )
        .innerJoin("deployments as d", "d.id", "o.deployment_id")
        .select(["s.enabled as siteEnabled", "d.enabled as deploymentEnabled"])
        .where("o.id", "=", source.owner_id)
        .executeTakeFirst();
      if (!owner?.siteEnabled || !owner.deploymentEnabled) return;
    }
    if (source.connection_id) {
      const connection = await this.db
        .selectFrom("connections")
        .select(["authority_generation", "state", "provider_registration_id"])
        .where("id", "=", source.connection_id)
        .executeTakeFirst();
      if (
        !connection ||
        connection.state === "disconnected" ||
        connection.authority_generation !== source.authority_generation ||
        connection.provider_registration_id !== source.provider_registration_id
      )
        return;
    }
    return source;
  }

  async visible(source: Source, access: AccessContext): Promise<boolean> {
    if (source.owner_id) {
      if (source.owner_id !== access.ownerId) return false;
    } else {
      const audience = await this.db
        .selectFrom("event_source_audience")
        .select("source_id")
        .where("source_id", "=", source.id)
        .where("deployment_id", "=", access.deploymentId)
        .where("site_id", "=", access.siteId)
        .where("subject_id", "=", access.subjectId)
        .executeTakeFirst();
      if (!audience) return false;
    }
    return (
      !source.connection_id || this.core.access.connectionVisible(access, source.connection_id)
    );
  }

  async retire(access: AccessContext, id: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await this.core.access.lockAuthority(tx, access);
      const source = await tx
        .selectFrom("event_sources")
        .selectAll()
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (!source || source.owner_id !== access.ownerId)
        throw new ServiceError(404, "not-found", "Event source not found");
      if (source.state === "retired") return;
      await tx
        .updateTable("event_sources")
        .set({
          state: "retired",
          revision: source.revision + 1,
          private_context: this.seal(
            source.id,
            source.provider_registration_id,
            source.revision + 1,
            {},
          ),
          claim_token: null,
          claim_incarnation: null,
          lease_until: null,
          operation: null,
          phase: null,
          renew_after: null,
        })
        .where("id", "=", id)
        .execute();
    });
  }

  /** Protected operator composition supplies verified setup; this is deliberately not a viewer route. */
  async associateOperator(input: {
    id: string;
    providerRegistrationId: string;
    appId: string;
    setupOwnerId: string;
    setup: "manual" | "app" | "service";
    publication: SourcePublication;
    connectionId?: string;
    authorityGeneration?: number;
    audience: readonly { deploymentId: string; siteId: string; subjectId: string }[];
  }): Promise<void> {
    opaqueId.parse(input.id);
    opaqueId.parse(input.providerRegistrationId);
    opaqueId.parse(input.appId);
    if ((input.connectionId === undefined) !== (input.authorityGeneration === undefined))
      throw new TypeError("Connection authority must be bound");
    await this.db.transaction().execute(async (tx) => {
      await tx
        .insertInto("event_sources")
        .values({
          id: input.id,
          provider_registration_id: input.providerRegistrationId,
          setup_app_id: input.appId,
          setup_kind: input.setup,
          owner_id: null,
          setup_owner_id: input.setupOwnerId,
          connection_id: input.connectionId ?? null,
          authority_generation: input.authorityGeneration ?? null,
          account_key: input.publication.accountKey,
          revision: 1,
          state: "active",
          verified: true,
          private_context: this.seal(
            input.id,
            input.providerRegistrationId,
            1,
            input.publication.privateContext,
          ),
          provider_expires_at: input.publication.expiresAt ?? null,
          renew_after: input.publication.renewAfter ?? null,
          claim_token: null,
          claim_incarnation: null,
          lease_until: null,
          operation: null,
          phase: null,
        })
        .execute();
      if (input.audience.length)
        await tx
          .insertInto("event_source_audience")
          .values(
            input.audience.map((audience) => ({
              source_id: input.id,
              deployment_id: audience.deploymentId,
              site_id: audience.siteId,
              subject_id: audience.subjectId,
            })),
          )
          .execute();
    });
  }

  backgroundAuthority(): BackgroundAuthorityPort {
    return {
      inspect: async (authority) => {
        if (authority.source !== "event-source") throw new Error("Unsupported source authority");
        const source = await this.get(authority.sourceId);
        if (!source) throw new Error("Source setup authority unavailable");
        const owner = await this.db
          .selectFrom("owners")
          .selectAll()
          .where("id", "=", source.setup_owner_id)
          .executeTakeFirstOrThrow();
        return {
          access: {
            ownerId: owner.id,
            deploymentId: owner.deployment_id,
            siteId: owner.site_id,
            subjectId: owner.subject_id,
            appId: source.setup_app_id,
          },
          ...(source.connection_id
            ? {
                connectionId: source.connection_id,
                authorityGeneration: source.authority_generation!,
              }
            : {}),
          started: true,
        };
      },
      lockClaim: async (tx, authority) => {
        if (authority.source !== "event-source") throw new Error("Unsupported source authority");
        await this.lockClaim(
          tx.withTables<Pick<EventsDatabase, "event_sources" | "event_source_audience">>(),
          authority,
        );
      },
    };
  }
  async lockClaim(
    tx: Transaction<EventsDatabase>,
    authority: Extract<OperationAuthority, { source: "event-source" }>,
  ): Promise<Selectable<EventSourcesTable>> {
    const source = await tx
      .selectFrom("event_sources")
      .selectAll()
      .where("id", "=", authority.sourceId)
      .forUpdate()
      .executeTakeFirst();
    // A lease can expire while FOR UPDATE waits; transaction-start time is not authority.
    const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(tx)).rows[0]!
      .now;
    if (
      !source ||
      source.claim_token !== authority.claim.token ||
      source.claim_incarnation !== authority.claim.incarnation ||
      !source.lease_until ||
      source.lease_until <= now ||
      (source.state === "retired" && source.operation !== "retire")
    )
      throw new ServiceError(409, "stale-source-claim", "Source claim is no longer current");
    return source;
  }
}
