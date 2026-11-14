import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { AccessContext, MaintenanceHook, OperationAuthority } from "../core-ports.js";
import { ServiceError } from "../http/errors.js";
import { ExecutionLifetime } from "../runtime/lifetime.js";
import type { Sources } from "./sources.js";
import type { Source } from "./types.js";

export type SourceMaintenanceOptions = {
  incarnation: string;
  leaseMs: number;
  cleanupMs: number;
  requestTermination(reason: string): void;
};
export class SourceMaintenance implements MaintenanceHook {
  constructor(
    readonly sources: Sources,
    readonly options: SourceMaintenanceOptions,
  ) {
    if (!options.incarnation || !Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1)
      throw new TypeError("Invalid source execution bounds");
  }
  async retire(access: AccessContext, id: string): Promise<void> {
    const retired = await this.sources.db.transaction().execute(async (tx) => {
      await this.sources.core.access.lockAuthority(tx, access);
      const previous = await tx
        .selectFrom("event_sources")
        .selectAll()
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (!previous || previous.owner_id !== access.ownerId)
        throw new ServiceError(404, "not-found", "Event source not found");
      if (previous.state === "retired") return;
      const hook = this.sources.providers.get(previous.provider_registration_id)?.hooks?.retire;
      const privateContext = hook ? this.sources.context(previous) : {};
      const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(tx)).rows[0]!
        .now;
      const claim = hook
        ? { token: randomUUID(), incarnation: this.options.incarnation }
        : undefined;
      const source = await tx
        .updateTable("event_sources")
        .set({
          state: "retired",
          revision: previous.revision + 1,
          private_context: this.sources.seal(
            id,
            previous.provider_registration_id,
            previous.revision + 1,
            {},
          ),
          renew_after: null,
          claim_token: claim?.token ?? null,
          claim_incarnation: claim?.incarnation ?? null,
          lease_until: claim ? new Date(now.getTime() + this.options.leaseMs) : null,
          operation: claim ? "retire" : null,
          phase: claim ? "claimed" : null,
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { source, claim, hook, privateContext };
    });
    if (!retired?.claim || !retired.hook) return;
    const { source, claim, hook, privateContext } = retired;
    const authority = { source: "event-source", sourceId: id, claim } as const;
    let uncertain = false;
    try {
      await new ExecutionLifetime({
        cleanupMs: this.options.cleanupMs,
        requestTermination: this.options.requestTermination,
        signal: AbortSignal.timeout(this.options.leaseMs),
      }).run(async (lifetime) => {
        await this.sources.db.transaction().execute(async (tx) => {
          await this.sources.core.connections.lockAuthority(
            tx,
            authority,
            source.provider_registration_id,
            source.connection_id ?? undefined,
          );
          await this.sources.lockClaim(tx, authority);
        });
        const scope = await this.sources.core.connections.openScope(
          authority,
          source.provider_registration_id,
          source.connection_id ?? undefined,
          lifetime.signal,
        );
        lifetime.own((reason) => scope.dispose(reason));
        await hook({
          source,
          privateContext,
          provider: scope.context,
          signal: lifetime.signal,
          markMayHaveDispatched: async () => {
            await this.sources.db.transaction().execute(async (tx) => {
              await this.sources.core.connections.lockAuthority(
                tx,
                authority,
                source.provider_registration_id,
                source.connection_id ?? undefined,
              );
              await this.sources.lockClaim(tx, authority);
              await tx
                .updateTable("event_sources")
                .set({ phase: "may-have-dispatched" })
                .where("id", "=", id)
                .execute();
            });
          },
        });
      });
    } catch {
      uncertain = true;
    }
    await this.sources.db
      .updateTable("event_sources")
      .set({
        claim_token: null,
        claim_incarnation: null,
        lease_until: null,
        operation: null,
        phase: uncertain ? "uncertain" : null,
      })
      .where("id", "=", id)
      .where("revision", "=", source.revision)
      .where("claim_token", "=", claim.token)
      .where("claim_incarnation", "=", claim.incarnation)
      .execute();
  }
  async run(signal: AbortSignal): Promise<void> {
    await this.recover();
    if (signal.aborted) return;
    const claimed = await this.sources.db.transaction().execute(async (tx) => {
      const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(tx)).rows[0]!
        .now;
      const candidates = await tx
        .selectFrom("event_sources")
        .selectAll()
        .where("setup_kind", "=", "service")
        .where("state", "in", ["configured", "active", "attention-required"])
        .where("claim_token", "is", null)
        .where("phase", "is", null)
        .where("renew_after", "<=", now)
        .orderBy("renew_after")
        .limit(16)
        .forUpdate()
        .skipLocked()
        .execute();
      for (const source of candidates) {
        const operation = source.state === "configured" ? "create" : "renew";
        if (!this.sources.providers.get(source.provider_registration_id)?.hooks?.[operation])
          continue;
        const claim = { token: randomUUID(), incarnation: this.options.incarnation };
        const updated = await tx
          .updateTable("event_sources")
          .set({
            claim_token: claim.token,
            claim_incarnation: claim.incarnation,
            lease_until: new Date(now.getTime() + this.options.leaseMs),
            operation,
            phase: "claimed",
          })
          .where("id", "=", source.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        return {
          source: updated,
          authority: { source: "event-source", sourceId: source.id, claim } as const,
        };
      }
    });
    if (!claimed) return;
    const { source, authority } = claimed;
    try {
      const lifetime = new ExecutionLifetime({
        cleanupMs: this.options.cleanupMs,
        requestTermination: this.options.requestTermination,
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.leaseMs)]),
      });
      const publication = await lifetime.run(async (lifetime) => {
        await this.sources.db.transaction().execute(async (tx) => {
          await this.sources.core.connections.lockAuthority(
            tx,
            authority,
            source.provider_registration_id,
            source.connection_id ?? undefined,
          );
          await this.sources.lockClaim(tx, authority);
        });
        const boundedSignal = lifetime.signal;
        const scope = await this.sources.core.connections.openScope(
          authority,
          source.provider_registration_id,
          source.connection_id ?? undefined,
          boundedSignal,
        );
        lifetime.own((reason) => scope.dispose(reason));
        try {
          const hook = this.sources.provider(source.provider_registration_id).hooks?.[
            source.operation!
          ];
          if (!hook) throw new Error("Source hook no longer configured");
          const publication = await hook({
            source,
            privateContext: this.sources.context(source),
            provider: scope.context,
            signal: boundedSignal,
            markMayHaveDispatched: async () => {
              await this.sources.db.transaction().execute(async (tx) => {
                await this.sources.core.connections.lockAuthority(
                  tx,
                  authority,
                  source.provider_registration_id,
                  source.connection_id ?? undefined,
                );
                await this.sources.lockClaim(tx, authority);
                await tx
                  .updateTable("event_sources")
                  .set({ phase: "may-have-dispatched" })
                  .where("id", "=", source.id)
                  .execute();
              });
            },
          });
          if (publication.accountKey !== source.account_key)
            throw new Error("Source hook account changed");
          return publication;
        } finally {
          await scope.dispose();
        }
      });
      await this.sources.db.transaction().execute(async (tx) => {
        await this.sources.core.connections.lockAuthority(
          tx,
          authority,
          source.provider_registration_id,
          source.connection_id ?? undefined,
        );
        const current = await this.sources.lockClaim(tx, authority);
        if (current.revision !== source.revision) throw new Error("Stale source hook result");
        const revision = current.revision + 1;
        await tx
          .updateTable("event_sources")
          .set({
            state: "active",
            verified: true,
            revision,
            private_context: this.sources.seal(
              source.id,
              source.provider_registration_id,
              revision,
              publication.privateContext,
            ),
            provider_expires_at: publication.expiresAt ?? null,
            renew_after: publication.renewAfter ?? null,
            claim_token: null,
            claim_incarnation: null,
            lease_until: null,
            phase: null,
            operation: null,
          })
          .where("id", "=", source.id)
          .execute();
      });
    } catch {
      // A failed/ambiguous mutation becomes attention-required; never automatically repeat business effects.
      await this.#finishFailure(source, authority);
    }
  }
  async #finishFailure(
    source: Source,
    authority: Extract<OperationAuthority, { source: "event-source" }>,
  ): Promise<void> {
    await this.sources.db
      .updateTable("event_sources")
      .set({
        state: source.verified ? "attention-required" : "configured",
        phase: "uncertain",
        claim_token: null,
        claim_incarnation: null,
        lease_until: null,
        renew_after: null,
        operation: null,
      })
      .where("id", "=", source.id)
      .where("revision", "=", source.revision)
      .where("claim_token", "=", authority.claim.token)
      .where("claim_incarnation", "=", authority.claim.incarnation)
      .execute();
  }
  async recover(): Promise<void> {
    // Expired leases fence old results. Even predispatch failures require explicit setup/reconciliation.
    await sql`update event_sources set state = case when state = 'retired' then 'retired' when verified then 'attention-required' else 'configured' end,
      phase = 'uncertain', claim_token = null, claim_incarnation = null, lease_until = null,
      renew_after = null, operation = null
      where lease_until <= clock_timestamp() and claim_token is not null`.execute(this.sources.db);
  }
}
