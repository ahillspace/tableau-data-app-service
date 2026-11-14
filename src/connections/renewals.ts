import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { OperationAuthority } from "../core-ports.js";
import { databaseTime } from "../db/database.js";
import { absent, ServiceError, stale } from "../http/errors.js";
import { providerProtocol } from "../providers/protocol.js";
import type { CredentialBundle } from "../providers/registry.js";
import type { CredentialsService, MutationRef } from "./credentials.js";
import type { ConnectionService } from "./service.js";

export class Renewals {
  readonly incarnation = randomUUID();
  constructor(
    readonly connections: ConnectionService,
    readonly credentials: CredentialsService,
    readonly options: { operationMs: number; leaseMs: number; contentionMs: number },
  ) {
    if (
      ![options.operationMs, options.leaseMs, options.contentionMs].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      ) ||
      options.leaseMs < options.operationMs
    )
      throw new Error("Invalid renewal timing");
  }
  async renew(
    authority: OperationAuthority,
    providerId: string,
    connectionId: string,
    generation: number,
    callerSignal: AbortSignal,
  ): Promise<void> {
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(this.options.operationMs)]);
    const provider = this.connections.providers.get(providerId),
      definition = provider.renewal;
    if (!definition)
      throw new ServiceError(422, "reauthorization-required", "Provider does not support renewal");
    const actor = await this.connections.renewalActor(
      authority,
      providerId,
      connectionId,
      generation,
    );
    let ref: MutationRef;
    while (true) {
      signal.throwIfAborted();
      const now = await databaseTime(this.connections.db);
      const current = await this.connections.db.transaction().execute(async (tx) => {
        await actor.lock(tx, providerId);
        const row = await tx
          .selectFrom("connections")
          .selectAll()
          .where("id", "=", connectionId)
          .executeTakeFirst();
        if (!row || row.authority_generation !== generation) absent();
        return { row, now: await databaseTime(tx) };
      });
      if (
        !current.row.mutation_id &&
        (!current.row.credential_expires_at || current.row.credential_expires_at > current.now)
      )
        return;
      try {
        ref = await this.credentials.reserve(
          actor,
          providerId,
          "renewal",
          new Date(
            Math.min(
              now.getTime() + this.options.operationMs,
              actor.authenticationExpiresAt.getTime(),
            ),
          ),
          { connectionId, expectedAuthorityGeneration: generation },
          undefined,
          async (_tx, reserved) => {
            if (reserved.expected.credentialGeneration !== current.row.credential_generation)
              throw new ServiceError(
                409,
                "credential-mutation-in-progress",
                "Credential generation changed during renewal selection",
              );
          },
        );
        break;
      } catch (error) {
        if (!(error instanceof ServiceError) || error.code !== "credential-mutation-in-progress")
          throw error;
        await delay(this.options.contentionMs, undefined, { signal });
      }
    }
    const protocol = providerProtocol(
      provider,
      this.connections.policy,
      this.connections.transportBudget,
    ).open(signal);
    try {
      const row = await this.connections.db
        .selectFrom("connections")
        .selectAll()
        .where("id", "=", connectionId)
        .executeTakeFirstOrThrow();
      if (
        row.authority_generation !== ref.expected.authorityGeneration ||
        row.credential_generation !== ref.expected.credentialGeneration ||
        !row.bundle
      )
        stale();
      const bytes = this.connections.secrets.open(row.bundle, {
        kind: "connection",
        id: row.id,
        provider: providerId,
        revision: `${row.authority_generation}:${row.credential_generation}`,
      });
      let previous: CredentialBundle;
      try {
        const parsed = JSON.parse(bytes.toString());
        previous = {
          credentials: provider.credentialsSchema.parse(parsed.credentials),
          runtimeContext: provider.contextSchema.parse(parsed.runtimeContext),
          display: row.display,
          expiresAt: row.credential_expires_at,
          accountKey: row.account_key,
          verifiedReauthorization: false,
        };
      } finally {
        bytes.fill(0);
      }
      const claim = await this.credentials.claim(
        actor,
        providerId,
        ref,
        this.incarnation,
        this.options.leaseMs,
      );
      await this.credentials.dispatch(actor, providerId, ref, claim, definition.mayInvalidate);
      const candidate = await definition.renew(previous, {
        signal,
        request: (url, init) => protocol.fetch(url, init),
      });
      signal.throwIfAborted();
      await this.credentials.publish(actor, provider, ref, claim, candidate);
    } catch (error) {
      await this.credentials.recover(ref, true);
      throw error;
    } finally {
      await protocol.dispose();
    }
  }
}
