import { randomUUID } from "node:crypto";
import type { Selectable } from "kysely";
import type { AccessService } from "../access/service.js";
import type { AccessContext, BundleRevision, ClaimRef } from "../core-ports.js";
import { type CoreTransaction, type Database, databaseTime } from "../db/database.js";
import type { ConnectionsTable, CredentialMutationsTable } from "../db/schema.js";
import { absent, ServiceError, stale } from "../http/errors.js";
import type { CredentialBundle, ProviderRegistration } from "../providers/registry.js";
import type { SecretBox } from "../security/encryption.js";

export type Replacement = { connectionId: string; expectedAuthorityGeneration: number };
export type MutationRef = Readonly<{
  id: string;
  kind: "setup" | "import" | "renewal";
  connectionId: string | null;
  setupId: string | null;
  expected: BundleRevision;
  expiresAt: Date;
}>;
type Connection = Selectable<ConnectionsTable>;
type Mutation = Selectable<CredentialMutationsTable>;
export type RetireConnection = (
  tx: CoreTransaction,
  connectionId: string,
  authorityGeneration: number,
) => Promise<void>;
// Created only by trusted composition. Background claims and operator authority
// remain live checks inside each short mutation transaction.
export type CredentialActor = {
  ownerId: string | null;
  sessionId: string | null;
  authenticationExpiresAt: Date;
  lock(tx: CoreTransaction, providerId: string, ref?: MutationRef): Promise<void>;
};
export type CredentialAuthority = AccessContext | CredentialActor;
type Actor = CredentialAuthority;
const inProgress = () =>
  new ServiceError(409, "credential-mutation-in-progress", "Credential mutation is in progress");
export class CredentialsService {
  constructor(
    readonly db: Database,
    readonly access: AccessService,
    readonly secrets: SecretBox,
    readonly retireConnection?: RetireConnection,
  ) {}
  private lockActor(tx: CoreTransaction, actor: Actor, providerId: string, ref?: MutationRef) {
    return "lock" in actor
      ? actor.lock(tx, providerId, ref)
      : this.access.lockAuthority(tx, actor, providerId);
  }

  async capture(
    access: Actor,
    provider: ProviderRegistration,
    replacement?: Replacement,
  ): Promise<Connection | undefined> {
    if (!replacement) return undefined;
    const connection = await this.db
      .selectFrom("connections")
      .selectAll()
      .where("id", "=", replacement.connectionId)
      .where("owner_id", access.ownerId === null ? "is" : "=", access.ownerId)
      .where("provider_registration_id", "=", provider.id)
      .executeTakeFirst();
    if (!connection) absent();
    if (
      connection.authority_generation !== replacement.expectedAuthorityGeneration ||
      connection.state === "disconnected"
    )
      stale();
    if (connection.mutation_id || connection.state === "renewal-uncertain") throw inProgress();
    return connection;
  }

  prepare(
    provider: ProviderRegistration,
    candidate: CredentialBundle,
    previous?: Connection,
    renewal = false,
  ) {
    const id = previous?.id ?? randomUUID();
    const authority =
      renewal && previous
        ? previous.authority_generation
        : previous
          ? previous.authority_generation +
            (candidate.accountKey !== null &&
            candidate.accountKey === previous.account_key &&
            candidate.verifiedReauthorization
              ? 0
              : 1)
          : 1;
    const credential = (previous?.credential_generation ?? 0) + 1;
    if (
      renewal &&
      (!previous ||
        previous.account_key !== candidate.accountKey ||
        candidate.verifiedReauthorization)
    )
      stale();
    const credentials = provider.credentialsSchema.parse(candidate.credentials);
    const context = provider.contextSchema.parse(candidate.runtimeContext);
    const bytes = Buffer.from(JSON.stringify({ credentials, runtimeContext: context }));
    try {
      return {
        id,
        authority,
        credential,
        envelope: this.secrets.seal(bytes, {
          kind: "connection",
          id,
          provider: provider.id,
          revision: `${authority}:${credential}`,
        }),
        candidate,
      };
    } finally {
      bytes.fill(0);
    }
  }

  async publishLocal(
    access: Actor,
    provider: ProviderRegistration,
    candidate: CredentialBundle,
    previous?: Connection,
    finalize?: (tx: CoreTransaction, row: Connection) => Promise<void>,
  ): Promise<Connection> {
    // Validation and authenticated encryption finish before any authority lock.
    const prepared = this.prepare(provider, candidate, previous);
    return this.db.transaction().execute(async (tx) => {
      await this.lockActor(tx, access, provider.id);
      if (previous) {
        const current = await tx
          .selectFrom("connections")
          .selectAll()
          .where("id", "=", previous.id)
          .forUpdate()
          .executeTakeFirst();
        if (
          !current ||
          current.owner_id !== access.ownerId ||
          current.provider_registration_id !== provider.id
        )
          absent();
        this.assertPair(current, {
          authorityGeneration: previous.authority_generation,
          credentialGeneration: previous.credential_generation,
        });
        if (current.mutation_id || current.state === "renewal-uncertain") throw inProgress();
        if (current.state === "disconnected") stale();
        if (prepared.authority !== current.authority_generation)
          await this.retireConnection?.(tx, current.id, current.authority_generation);
      }
      const time = await databaseTime(tx);
      if (access.authenticationExpiresAt <= time)
        throw new ServiceError(401, "authentication-required", "Verified authentication required");
      const values = {
        state: "active" as const,
        authority_generation: prepared.authority,
        credential_generation: prepared.credential,
        bundle: prepared.envelope,
        display: candidate.display,
        credential_expires_at: candidate.expiresAt,
        account_key: candidate.accountKey,
        last_connector_reauth_at: candidate.verifiedReauthorization
          ? time
          : (previous?.last_connector_reauth_at ?? null),
        mutation_id: null,
      };
      const row = previous
        ? await tx
            .updateTable("connections")
            .set(values)
            .where("id", "=", prepared.id)
            .returningAll()
            .executeTakeFirstOrThrow()
        : await tx
            .insertInto("connections")
            .values({
              id: prepared.id,
              provider_registration_id: provider.id,
              owner_id: access.ownerId,
              ...values,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
      await finalize?.(tx, row);
      if (access.authenticationExpiresAt <= (await databaseTime(tx))) stale();
      return row;
    });
  }

  async reserve(
    access: Actor,
    providerId: string,
    kind: Mutation["kind"],
    expiresAt: Date,
    replacement?: Replacement,
    setupId?: string,
    onReserve?: (tx: CoreTransaction, ref: MutationRef) => Promise<void>,
  ): Promise<MutationRef> {
    return this.db.transaction().execute(async (tx) => {
      await this.lockActor(tx, access, providerId);
      let previous: Connection | undefined;
      if (replacement) {
        previous = await tx
          .selectFrom("connections")
          .selectAll()
          .where("id", "=", replacement.connectionId)
          .forUpdate()
          .executeTakeFirst();
        if (
          !previous ||
          previous.owner_id !== access.ownerId ||
          previous.provider_registration_id !== providerId
        )
          absent();
        if (
          previous.authority_generation !== replacement.expectedAuthorityGeneration ||
          previous.state === "disconnected"
        )
          stale();
        if (previous.mutation_id || previous.state === "renewal-uncertain") throw inProgress();
      } else if (!setupId) throw new Error("New credential mutation requires a setup reference");
      const time = await databaseTime(tx);
      if (expiresAt <= time || expiresAt > access.authenticationExpiresAt)
        throw new ServiceError(400, "invalid-expiry", "Invalid mutation expiry");
      const id = randomUUID();
      const expected = {
        authorityGeneration: previous?.authority_generation ?? 0,
        credentialGeneration: previous?.credential_generation ?? 0,
      };
      await tx
        .insertInto("credential_mutations")
        .values({
          id,
          connection_id: previous?.id ?? null,
          setup_id: previous ? null : (setupId ?? null),
          kind,
          expected_authority: expected.authorityGeneration,
          expected_credential: expected.credentialGeneration,
          expires_at: expiresAt,
          phase: "reserved",
          may_invalidate: false,
          processor_token: null,
          incarnation: null,
          lease_until: null,
          access_session_id: access.sessionId,
          evidence: null,
        })
        .execute();
      if (previous)
        await tx
          .updateTable("connections")
          .set({ mutation_id: id })
          .where("id", "=", previous.id)
          .execute();
      const ref = {
        id,
        kind,
        connectionId: previous?.id ?? null,
        setupId: setupId ?? null,
        expected,
        expiresAt,
      };
      await onReserve?.(tx, ref);
      if (
        access.authenticationExpiresAt <= (await databaseTime(tx)) ||
        ref.expiresAt <= (await databaseTime(tx))
      )
        stale();
      return ref;
    });
  }

  private assertPair(connection: Connection, expected: BundleRevision): void {
    if (
      connection.authority_generation !== expected.authorityGeneration ||
      connection.credential_generation !== expected.credentialGeneration
    )
      stale();
  }
  private async lockMutation(
    tx: CoreTransaction,
    ref: MutationRef,
  ): Promise<{ mutation: Mutation; connection?: Connection }> {
    let connection: Connection | undefined;
    if (ref.connectionId) {
      connection = await tx
        .selectFrom("connections")
        .selectAll()
        .where("id", "=", ref.connectionId)
        .forUpdate()
        .executeTakeFirst();
      if (!connection || connection.mutation_id !== ref.id || connection.state === "disconnected")
        stale();
      this.assertPair(connection, ref.expected);
    }
    const mutation = await tx
      .selectFrom("credential_mutations")
      .selectAll()
      .where("id", "=", ref.id)
      .forUpdate()
      .executeTakeFirst();
    if (
      !mutation ||
      mutation.expected_authority !== ref.expected.authorityGeneration ||
      mutation.kind !== ref.kind ||
      mutation.expected_credential !== ref.expected.credentialGeneration ||
      ["uncertain", "succeeded", "failed"].includes(mutation.phase)
    )
      stale();
    return { mutation, ...(connection ? { connection } : {}) };
  }
  private async live(tx: CoreTransaction, mutation: Mutation, claim?: ClaimRef): Promise<Date> {
    const time = await databaseTime(tx);
    if (
      mutation.expires_at <= time ||
      (claim &&
        (mutation.processor_token !== claim.token ||
          mutation.incarnation !== claim.incarnation ||
          !mutation.lease_until ||
          mutation.lease_until <= time))
    )
      stale();
    return time;
  }
  async claim(
    access: Actor,
    providerId: string,
    ref: MutationRef,
    incarnation: string,
    leaseMs: number,
    onClaim?: (tx: CoreTransaction, claim: ClaimRef) => Promise<void>,
  ): Promise<ClaimRef> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("Invalid mutation lease");
    return this.db.transaction().execute(async (tx) => {
      await this.lockActor(tx, access, providerId, ref);
      const { mutation } = await this.lockMutation(tx, ref);
      const time = await this.live(tx, mutation);
      if (mutation.processor_token || !["reserved", "waiting"].includes(mutation.phase)) stale();
      const claim = { token: randomUUID(), incarnation };
      await tx
        .updateTable("credential_mutations")
        .set({
          phase: "processing",
          processor_token: claim.token,
          incarnation,
          lease_until: new Date(Math.min(time.getTime() + leaseMs, ref.expiresAt.getTime())),
        })
        .where("id", "=", ref.id)
        .execute();
      await onClaim?.(tx, claim);
      const finalTime = await databaseTime(tx);
      if (
        access.authenticationExpiresAt <= finalTime ||
        Math.min(time.getTime() + leaseMs, ref.expiresAt.getTime()) <= finalTime.getTime()
      )
        stale();
      return claim;
    });
  }
  async dispatch(
    access: Actor,
    providerId: string,
    ref: MutationRef,
    claim: ClaimRef,
    mayInvalidate: boolean,
  ): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await this.lockActor(tx, access, providerId, ref);
      const { mutation } = await this.lockMutation(tx, ref);
      await this.live(tx, mutation, claim);
      if (mutation.phase !== "processing" && mutation.phase !== "dispatched") stale();
      await tx
        .updateTable("credential_mutations")
        .set({ phase: "dispatched", may_invalidate: mutation.may_invalidate || mayInvalidate })
        .where("id", "=", ref.id)
        .execute();
    });
  }
  async wait(access: Actor, providerId: string, ref: MutationRef, claim: ClaimRef): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await this.lockActor(tx, access, providerId, ref);
      const { mutation } = await this.lockMutation(tx, ref);
      await this.live(tx, mutation, claim);
      await tx
        .updateTable("credential_mutations")
        .set({ phase: "waiting", processor_token: null, incarnation: null, lease_until: null })
        .where("id", "=", ref.id)
        .execute();
    });
  }
  async publish(
    access: Actor,
    provider: ProviderRegistration,
    ref: MutationRef,
    claim: ClaimRef,
    candidate: CredentialBundle,
    finalize?: (tx: CoreTransaction, row: Connection) => Promise<void>,
  ): Promise<Connection> {
    const previous = ref.connectionId
      ? await this.db
          .selectFrom("connections")
          .selectAll()
          .where("id", "=", ref.connectionId)
          .executeTakeFirst()
      : undefined;
    if (previous) this.assertPair(previous, ref.expected);
    const prepared = this.prepare(provider, candidate, previous, ref.kind === "renewal");
    return this.db.transaction().execute(async (tx) => {
      await this.lockActor(tx, access, provider.id, ref);
      const { mutation, connection } = await this.lockMutation(tx, ref);
      const time = await this.live(tx, mutation, claim);
      if (mutation.access_session_id !== access.sessionId) stale();
      if (connection && prepared.authority !== connection.authority_generation)
        await this.retireConnection?.(tx, connection.id, connection.authority_generation);
      const values = {
        state: "active" as const,
        authority_generation: prepared.authority,
        credential_generation: prepared.credential,
        bundle: prepared.envelope,
        display: candidate.display,
        credential_expires_at: candidate.expiresAt,
        account_key: candidate.accountKey,
        last_connector_reauth_at:
          ref.kind !== "renewal" && candidate.verifiedReauthorization
            ? time
            : (connection?.last_connector_reauth_at ?? null),
        mutation_id: null,
      };
      const row = connection
        ? await tx
            .updateTable("connections")
            .set(values)
            .where("id", "=", connection.id)
            .returningAll()
            .executeTakeFirstOrThrow()
        : await tx
            .insertInto("connections")
            .values({
              id: prepared.id,
              provider_registration_id: provider.id,
              owner_id: access.ownerId,
              ...values,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
      await tx
        .updateTable("credential_mutations")
        .set({ phase: "succeeded", processor_token: null, incarnation: null, lease_until: null })
        .where("id", "=", ref.id)
        .execute();
      await finalize?.(tx, row);
      const finalTime = await this.live(tx, mutation, claim);
      if (access.authenticationExpiresAt <= finalTime)
        throw new ServiceError(401, "authentication-required", "Verified authentication required");
      return row;
    });
  }
  async recover(
    ref: MutationRef,
    forced = false,
    options?: {
      initiator?: { access: Actor; providerId: string };
      finalize(tx: CoreTransaction): Promise<void>;
    },
  ): Promise<"released" | "uncertain" | "stale"> {
    return this.db.transaction().execute(async (tx) => {
      if (options?.initiator)
        await this.lockActor(tx, options.initiator.access, options.initiator.providerId, ref);
      const connection = ref.connectionId
        ? await tx
            .selectFrom("connections")
            .selectAll()
            .where("id", "=", ref.connectionId)
            .forUpdate()
            .executeTakeFirst()
        : undefined;
      const mutation = await tx
        .selectFrom("credential_mutations")
        .selectAll()
        .where("id", "=", ref.id)
        .forUpdate()
        .executeTakeFirst();
      if (
        !mutation ||
        ["succeeded", "failed", "uncertain"].includes(mutation.phase) ||
        (ref.connectionId &&
          (!connection ||
            connection.mutation_id !== ref.id ||
            connection.authority_generation !== ref.expected.authorityGeneration ||
            connection.credential_generation !== ref.expected.credentialGeneration ||
            connection.state === "disconnected"))
      )
        return "stale";
      const time = await databaseTime(tx);
      if (
        !forced &&
        mutation.expires_at > time &&
        (!mutation.lease_until || mutation.lease_until > time)
      )
        return "stale";
      const uncertain = mutation.may_invalidate;
      await tx
        .updateTable("credential_mutations")
        .set({
          phase: uncertain ? "uncertain" : "failed",
          processor_token: null,
          incarnation: null,
          lease_until: null,
        })
        .where("id", "=", ref.id)
        .execute();
      if (connection)
        await tx
          .updateTable("connections")
          .set(uncertain ? { state: "renewal-uncertain" } : { mutation_id: null })
          .where("id", "=", connection.id)
          .execute();
      await options?.finalize(tx);
      if (
        options?.initiator &&
        options.initiator.access.authenticationExpiresAt <= (await databaseTime(tx))
      )
        throw new ServiceError(401, "authentication-required", "Verified authentication required");
      return uncertain ? "uncertain" : "released";
    });
  }
}
