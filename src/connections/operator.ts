import { randomUUID } from "node:crypto";
import type { CoreTransaction, Database } from "../db/database.js";
import { databaseTime } from "../db/database.js";
import { ServiceError } from "../http/errors.js";
import { providerProtocol } from "../providers/protocol.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { TransportPolicy } from "../transport/native.js";
import type { CredentialActor, CredentialsService, Replacement } from "./credentials.js";

export type SharedAudience = readonly { deploymentId: string; siteId: string; subjectId: string }[];
export class OperatorConnections {
  constructor(
    readonly db: Database,
    readonly credentials: CredentialsService,
    readonly providers: ProviderRegistry,
    readonly policy: TransportPolicy,
    readonly options: { operationMs: number; leaseMs: number },
    readonly actorIds: ReadonlySet<string>,
  ) {}
  actor(
    actorId: string,
    appId: string,
    providerId: string,
    audience: SharedAudience,
    expiresAt = new Date(Date.now() + this.options.operationMs),
  ): CredentialActor {
    if (!this.actorIds.has(actorId))
      throw new ServiceError(
        403,
        "operator-authority-unavailable",
        "Operator authority is unavailable",
      );
    const provider = this.providers.get(providerId);
    if (provider.mode !== "operator")
      throw new ServiceError(422, "unsupported-setup", "Provider is not operator managed");
    return {
      ownerId: null,
      sessionId: null,
      authenticationExpiresAt: expiresAt,
      lock: async (tx) => {
        if (!this.actorIds.has(actorId))
          throw new ServiceError(
            403,
            "operator-authority-unavailable",
            "Operator authority is unavailable",
          );
        for (const deploymentId of [...new Set(audience.map((item) => item.deploymentId))].sort()) {
          const deployment = await tx
            .selectFrom("deployments")
            .select("enabled")
            .where("id", "=", deploymentId)
            .forShare()
            .executeTakeFirst();
          if (!deployment?.enabled)
            throw new ServiceError(
              403,
              "operator-authority-unavailable",
              "Audience deployment is unavailable",
            );
        }
        const sites = [
          ...new Map(
            audience.map((item) => [JSON.stringify([item.deploymentId, item.siteId]), item]),
          ).values(),
        ].sort(
          (a, b) =>
            a.deploymentId.localeCompare(b.deploymentId) || a.siteId.localeCompare(b.siteId),
        );
        for (const item of sites) {
          const site = await tx
            .selectFrom("tableau_sites")
            .select("enabled")
            .where("deployment_id", "=", item.deploymentId)
            .where("site_id", "=", item.siteId)
            .forShare()
            .executeTakeFirst();
          if (!site?.enabled)
            throw new ServiceError(
              403,
              "operator-authority-unavailable",
              "Audience site is unavailable",
            );
        }
        const registration = await tx
          .selectFrom("provider_registrations")
          .selectAll()
          .where("id", "=", providerId)
          .forShare()
          .executeTakeFirst();
        const app = await tx
          .selectFrom("apps")
          .select("enabled")
          .where("id", "=", appId)
          .forShare()
          .executeTakeFirst();
        if (
          !registration?.enabled ||
          registration.mode !== "operator" ||
          registration.config_revision !== provider.revision ||
          !app?.enabled ||
          expiresAt <= (await databaseTime(tx))
        )
          throw new ServiceError(
            403,
            "operator-authority-unavailable",
            "Current operator configuration is unavailable",
          );
      },
    };
  }
  async publishAudience(
    tx: CoreTransaction,
    connectionId: string,
    audience: SharedAudience,
  ): Promise<void> {
    await tx.deleteFrom("connection_audience").where("connection_id", "=", connectionId).execute();
    const entries = [
      ...new Map(
        audience.map((item) => [
          JSON.stringify([item.deploymentId, item.siteId, item.subjectId]),
          item,
        ]),
      ).values(),
    ];
    if (entries.length)
      await tx
        .insertInto("connection_audience")
        .values(
          entries.map((item) => ({
            connection_id: connectionId,
            deployment_id: item.deploymentId,
            site_id: item.siteId,
            subject_id: item.subjectId,
          })),
        )
        .execute();
  }
  async import(
    actorId: string,
    appId: string,
    input: {
      providerRegistrationId: string;
      audience: SharedAudience;
      inputs: Record<string, unknown>;
      replacement?: Replacement;
    },
    callerSignal: AbortSignal,
  ) {
    const provider = this.providers.get(input.providerRegistrationId),
      setup = provider.staticSetup;
    if (!setup) throw new ServiceError(422, "unsupported-setup", "Static setup is unsupported");
    const actor = this.actor(actorId, appId, provider.id, input.audience);
    const validated = setup.inputSchema.parse(input.inputs);
    const previous = await this.credentials.capture(actor, provider, input.replacement);
    const ref = setup.remote
      ? await this.credentials.reserve(
          actor,
          provider.id,
          "import",
          actor.authenticationExpiresAt,
          input.replacement,
          randomUUID(),
        )
      : undefined;
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(this.options.operationMs)]);
    const protocol = providerProtocol(provider, this.policy).open(signal);
    try {
      const claim = ref
        ? await this.credentials.claim(actor, provider.id, ref, randomUUID(), this.options.leaseMs)
        : undefined;
      if (ref && claim)
        await this.credentials.dispatch(actor, provider.id, ref, claim, setup.mayInvalidate);
      const candidate = await setup.prepare(validated, {
        signal,
        request: (url, init) => {
          if (!setup.remote) throw new Error("Local operator import attempted provider I/O");
          return protocol.fetch(url, init);
        },
      });
      signal.throwIfAborted();
      const finalize = (tx: CoreTransaction, row: { id: string }) =>
        this.publishAudience(tx, row.id, input.audience);
      return ref && claim
        ? await this.credentials.publish(actor, provider, ref, claim, candidate, finalize)
        : await this.credentials.publishLocal(actor, provider, candidate, previous, finalize);
    } catch (error) {
      if (ref) await this.credentials.recover(ref, true);
      throw error;
    } finally {
      await protocol.dispose();
    }
  }
}
