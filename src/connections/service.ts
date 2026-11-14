import { sql } from "kysely";
import type { AccessService } from "../access/service.js";
import { authFailure } from "../access/service.js";
import type {
  AccessContext,
  BackgroundAuthorityPort,
  BackgroundScope,
  ConnectionPort,
  ConnectionUse,
  CredentialSnapshot,
  OperationAuthority,
  ProviderScope,
} from "../core-ports.js";
import { type CoreTransaction, type Database, databaseTime } from "../db/database.js";
import { absent, ServiceError } from "../http/errors.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ConnectionView } from "../public/schemas.js";
import type { SecretBox } from "../security/encryption.js";
import { SocketBudget, type TransportPolicy, TransportScope } from "../transport/native.js";
import { type PreparedRequest, prepareRequest } from "./snapshot.js";

export class ConnectionService implements ConnectionPort {
  readonly #background = new Map<string, BackgroundAuthorityPort>();
  readonly transportBudget: SocketBudget;
  constructor(
    readonly db: Database,
    readonly access: AccessService,
    readonly secrets: SecretBox,
    readonly providers: ProviderRegistry,
    readonly policy: TransportPolicy,
  ) {
    this.transportBudget = new SocketBudget(policy.maxSockets);
  }
  registerAuthority(
    source: "job" | "remote-cancel" | "event-source",
    port: BackgroundAuthorityPort,
  ): void {
    if (this.#background.has(source)) throw new Error("Duplicate background authority owner");
    this.#background.set(source, port);
  }
  async authorizeUse(
    access: AccessContext,
    registrationId: string,
    connectionId?: string,
  ): Promise<ConnectionUse | null> {
    return (
      await prepareRequest(
        this.db,
        this.secrets,
        this.providers.get(registrationId),
        access.appId,
        { access },
        connectionId,
      )
    ).use;
  }
  async prepare(
    token: string,
    appId: string,
    registrationId: string,
    connectionId?: string,
  ): Promise<PreparedRequest> {
    return prepareRequest(
      this.db,
      this.secrets,
      this.providers.get(registrationId),
      appId,
      { token },
      connectionId,
    );
  }
  async openScope(
    authority: OperationAuthority,
    registrationId: string,
    connectionId: string | undefined,
    signal: AbortSignal,
  ): Promise<ProviderScope> {
    const prepared =
      authority.source === "request"
        ? await prepareRequest(
            this.db,
            this.secrets,
            this.providers.get(registrationId),
            authority.access.appId,
            { access: authority.access },
            connectionId,
          )
        : undefined;
    return this.scope(authority, registrationId, connectionId, signal, prepared);
  }
  openPrepared(
    prepared: PreparedRequest,
    registrationId: string,
    signal: AbortSignal,
  ): ProviderScope {
    return this.scope(
      { source: "request", access: prepared.access },
      registrationId,
      prepared.use?.connectionId,
      signal,
      prepared,
    );
  }
  private scope(
    authority: OperationAuthority,
    registrationId: string,
    connectionId: string | undefined,
    signal: AbortSignal,
    prepared?: PreparedRequest,
  ): ProviderScope {
    const provider = this.providers.get(registrationId);
    const transport = new TransportScope(this.policy, signal, this.transportBudget);
    let first = prepared;
    const checkout = async (): Promise<CredentialSnapshot | null> => {
      transport.signal.throwIfAborted();
      if (first) {
        const current = first;
        first = undefined;
        return current.take();
      }
      if (authority.source === "request") {
        const fresh = await prepareRequest(
          this.db,
          this.secrets,
          provider,
          authority.access.appId,
          { access: authority.access },
          connectionId,
        );
        return fresh.take();
      }
      return this.backgroundCheckout(authority, registrationId, connectionId);
    };
    return {
      context: {
        signal: transport.signal,
        request: async (request) => {
          const endpoint = provider.endpoints[request.endpoint];
          if (!endpoint)
            throw new ServiceError(422, "unsupported-endpoint", "Provider endpoint is unsupported");
          const snapshot = await checkout();
          return transport.request(
            endpoint,
            request,
            snapshot ? provider.attach(snapshot) : new Headers(),
            snapshot?.runtimeContext,
          );
        },
        withCredentials: async (run) => {
          const snapshot = await checkout();
          if (!snapshot)
            throw new ServiceError(422, "no-credentials", "This provider has no credentials");
          return run(snapshot);
        },
      },
      dispose: (reason) => transport.dispose(reason),
    };
  }
  private async backgroundCheckout(
    authority: Exclude<OperationAuthority, { source: "request" }>,
    registrationId: string,
    connectionId: string | undefined,
  ): Promise<CredentialSnapshot | null> {
    const provider = this.providers.get(registrationId);
    const selected = await this.db
      .transaction()
      .execute((tx) => this.lockBound(tx, authority, registrationId, connectionId));
    if (!selected?.bundle) return null;
    const plaintext = this.secrets.open(selected.bundle, {
      kind: "connection",
      id: selected.id,
      provider: registrationId,
      revision: `${selected.authority_generation}:${selected.credential_generation}`,
    });
    try {
      const parsed = JSON.parse(plaintext.toString()) as {
        credentials: unknown;
        runtimeContext: unknown;
      };
      return {
        authorityGeneration: selected.authority_generation,
        credentialGeneration: selected.credential_generation,
        credentials: provider.credentialsSchema.parse(parsed.credentials),
        runtimeContext: provider.contextSchema.parse(parsed.runtimeContext),
      };
    } finally {
      plaintext.fill(0);
    }
  }
  async lockAuthority(
    tx: CoreTransaction,
    authority: Exclude<OperationAuthority, { source: "request" }>,
    registrationId: string,
    connectionId?: string,
  ): Promise<void> {
    await this.lockBound(tx, authority, registrationId, connectionId);
  }
  private async lockBound(
    tx: CoreTransaction,
    authority: Exclude<OperationAuthority, { source: "request" }>,
    registrationId: string,
    connectionId?: string,
  ) {
    const owner = this.#background.get(authority.source);
    if (!owner)
      throw new ServiceError(503, "authority-unavailable", "Background authority is unavailable");
    const inspected = await owner.inspect(authority);
    if (inspected.connectionId !== connectionId)
      throw new ServiceError(403, "connection-mismatch", "Original connection is required");
    const scope: BackgroundScope = {
      ...inspected,
      providerRegistrationId: registrationId,
      purpose:
        authority.source === "job"
          ? "observe"
          : authority.source === "remote-cancel"
            ? "remote-cancel"
            : "event-source",
    };
    await this.lockBackgroundRows(tx, scope);
    await owner.lockClaim(tx, authority);
    return this.lockBackgroundRows(tx, scope);
  }
  async lockBackground(tx: CoreTransaction, scope: BackgroundScope): Promise<void> {
    await this.lockBackgroundRows(tx, scope);
  }
  private async lockBackgroundRows(tx: CoreTransaction, scope: BackgroundScope) {
    const registrationId = scope.providerRegistrationId;
    const connectionId = scope.connectionId;
    const provider = this.providers.get(registrationId);
    const deployment = await tx
      .selectFrom("deployments")
      .select("enabled")
      .where("id", "=", scope.access.deploymentId)
      .forShare()
      .executeTakeFirst();
    const site = await tx
      .selectFrom("tableau_sites")
      .select("enabled")
      .where("deployment_id", "=", scope.access.deploymentId)
      .where("site_id", "=", scope.access.siteId)
      .forShare()
      .executeTakeFirst();
    const registration = await tx
      .selectFrom("provider_registrations")
      .selectAll()
      .where("id", "=", registrationId)
      .forShare()
      .executeTakeFirst();
    const app = await tx
      .selectFrom("apps")
      .select("enabled")
      .where("id", "=", scope.access.appId)
      .forShare()
      .executeTakeFirst();
    if (
      !deployment?.enabled ||
      !site?.enabled ||
      !registration?.enabled ||
      !app?.enabled ||
      registration.config_revision !== provider.revision ||
      registration.mode !== provider.mode
    )
      throw new ServiceError(403, "authority-unavailable", "Current authority is unavailable");
    let connection = null;
    if (provider.mode !== "none") {
      if (!connectionId) absent();
      connection = await tx
        .selectFrom("connections")
        .selectAll()
        .where("id", "=", connectionId)
        .forShare()
        .executeTakeFirst();
      if (
        !connection ||
        connection.provider_registration_id !== registrationId ||
        connection.authority_generation !== scope.authorityGeneration ||
        connection.state !== "active" ||
        !connection.bundle
      )
        absent();
      if (provider.mode === "personal" && connection.owner_id !== scope.access.ownerId) absent();
      if (provider.mode === "operator") {
        const membership = await tx
          .selectFrom("connection_audience")
          .select("connection_id")
          .where("connection_id", "=", connectionId)
          .where("deployment_id", "=", scope.access.deploymentId)
          .where("site_id", "=", scope.access.siteId)
          .where("subject_id", "in", ["*", scope.access.subjectId])
          .executeTakeFirst();
        if (connection.owner_id !== null || !membership) absent();
      }
      if (connection.mutation_id) {
        const mutation = await tx
          .selectFrom("credential_mutations")
          .select("may_invalidate")
          .where("id", "=", connection.mutation_id)
          .forShare()
          .executeTakeFirst();
        if (mutation?.may_invalidate)
          throw new ServiceError(422, "renewal-uncertain", "Connection is unavailable");
      }
    } else if (connectionId)
      throw new ServiceError(400, "irrelevant-connection", "This provider has no connection");
    const time = await databaseTime(tx);
    if (connection?.credential_expires_at && connection.credential_expires_at <= time)
      throw new ServiceError(422, "reauthorization-required", "Provider credential expired");
    if (
      connection &&
      registration.reauth_seconds !== null &&
      !(scope.started && scope.purpose === "observe")
    ) {
      if (
        !connection.last_connector_reauth_at ||
        connection.last_connector_reauth_at.getTime() + registration.reauth_seconds * 1000 <=
          time.getTime()
      )
        throw new ServiceError(
          422,
          "reauthorization-required",
          "Connector reauthorization required",
        );
    }
    return connection;
  }
  async disconnect(access: AccessContext, connectionId: string, expected: number): Promise<void> {
    const hint = await this.db
      .selectFrom("connections")
      .select("provider_registration_id")
      .where("id", "=", connectionId)
      .where("owner_id", "=", access.ownerId)
      .executeTakeFirst();
    if (!hint) absent();
    await this.db.transaction().execute(async (tx) => {
      await this.access.lockAuthority(tx, access, hint.provider_registration_id);
      const row = await tx
        .selectFrom("connections")
        .selectAll()
        .where("id", "=", connectionId)
        .forUpdate()
        .executeTakeFirst();
      if (!row || row.owner_id !== access.ownerId) absent();
      if (row.authority_generation !== expected)
        throw new ServiceError(409, "stale-mutation", "Connection changed");
      if (row.mutation_id)
        await tx
          .updateTable("credential_mutations")
          .set({ phase: "failed", processor_token: null, incarnation: null, lease_until: null })
          .where("id", "=", row.mutation_id)
          .execute();
      if (access.authenticationExpiresAt <= (await databaseTime(tx))) throw authFailure();
      await tx
        .updateTable("connections")
        .set({
          state: "disconnected",
          authority_generation: row.authority_generation + 1,
          bundle: null,
          account_key: null,
          mutation_id: null,
        })
        .where("id", "=", connectionId)
        .execute();
    });
  }
  async list(access: AccessContext, connectionId?: string): Promise<ConnectionView[]> {
    const rows = (
      await sql<{
        id: string;
        provider_registration_id: string;
        owner_id: string | null;
        state: ConnectionView["state"];
        authority_generation: number;
        display: ConnectionView["display"];
        credential_expires_at: Date | null;
        last_connector_reauth_at: Date | null;
        reauth_seconds: number | null;
        may_invalidate: boolean | null;
        time: Date;
      }>`
      select c.id,c.provider_registration_id,c.owner_id,c.state,c.authority_generation,c.display,c.credential_expires_at,c.last_connector_reauth_at,p.reauth_seconds,m.may_invalidate,clock_timestamp() as time
      from connections c join provider_registrations p on p.id=c.provider_registration_id
      left join credential_mutations m on m.id=c.mutation_id
      where p.enabled and (${connectionId ?? null}::text is null or c.id=${connectionId ?? null})
      and (c.owner_id=${access.ownerId} or (c.owner_id is null and exists(select 1 from connection_audience ca where ca.connection_id=c.id and ca.deployment_id=${access.deploymentId} and ca.site_id=${access.siteId} and ca.subject_id in ('*',${access.subjectId})))) order by c.id limit 200
    `.execute(this.db)
    ).rows;
    return rows.map((row) => {
      const fresh =
        row.reauth_seconds === null ||
        (row.last_connector_reauth_at !== null &&
          row.last_connector_reauth_at.getTime() + row.reauth_seconds * 1000 > row.time.getTime());
      const usable =
        row.state === "active" &&
        !row.may_invalidate &&
        fresh &&
        (!row.credential_expires_at || row.credential_expires_at > row.time);
      return {
        id: row.id,
        providerRegistrationId: row.provider_registration_id,
        ownership: row.owner_id ? "personal" : "operator",
        state: row.may_invalidate ? "renewal-uncertain" : row.state,
        authorityGeneration: row.authority_generation,
        display: row.display,
        readyEndpoints: usable
          ? Object.keys(this.providers.get(row.provider_registration_id).endpoints)
          : [],
        connectorReauthRequired: !fresh,
        canManage: row.owner_id === access.ownerId,
      };
    });
  }
}
