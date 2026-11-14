import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import type { AccessContext } from "../core-ports.js";
import { type Database, databaseTime } from "../db/database.js";
import { absent, ServiceError, stale } from "../http/errors.js";
import type { SessionResponse } from "../public/schemas.js";
import type { SecretBox } from "../security/encryption.js";
import { randomSecret, verifier, verifySecret } from "../security/secrets.js";
import type { AdapterState, IdentityAdapter } from "./adapters.js";
import { AccessService, authFailure } from "./service.js";

const adapterStateSchema = z.strictObject({
  state: z.string(),
  verifier: z.string(),
  nonce: z.string(),
  clientId: z.string(),
  deviceId: z.string(),
});
// Initial cross-client silent-enrollment hardening is explicitly deferred.
// State, PKCE, one-use initiation proof and callback cookie remain mandatory.
function response(access: AccessContext, accessToken: string, expiresAt: Date): SessionResponse {
  return {
    accessToken,
    expiresAt: expiresAt.toISOString(),
    authenticationExpiresAt: access.authenticationExpiresAt.toISOString(),
    identity: {
      deploymentId: access.deploymentId,
      siteId: access.siteId,
      subjectId: access.subjectId,
    },
  };
}
export function restorationCookieName(deploymentId: string): string {
  return `__Host-integration-${createHash("sha256").update(deploymentId).digest("hex").slice(0, 16)}`;
}
export function cookieValue(header: string | undefined, name: string): string | undefined {
  const found = (header ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (found.length !== 1) return undefined;
  const value = found[0]?.slice(name.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
export class SessionService {
  readonly incarnation = randomUUID();
  constructor(
    readonly db: Database,
    readonly access: AccessService,
    readonly secrets: SecretBox,
    readonly adapters: ReadonlyMap<string, IdentityAdapter>,
    readonly transactionLifetimeMs: number,
  ) {
    if (!Number.isSafeInteger(transactionLifetimeMs) || transactionLifetimeMs <= 0)
      throw new Error("Invalid transaction lifetime");
  }
  async begin(appId: string, deploymentId: string, initiationVerifier: string) {
    const adapter = this.adapters.get(deploymentId);
    if (!adapter || !/^[a-f0-9]{64}$/.test(initiationVerifier))
      throw new ServiceError(400, "invalid-input", "Invalid authentication selection");
    const id = randomUUID();
    return this.db.transaction().execute(async (tx) => {
      const deployment = await tx
        .selectFrom("deployments")
        .selectAll()
        .where("id", "=", deploymentId)
        .forShare()
        .executeTakeFirst();
      const app = await tx
        .selectFrom("apps")
        .select("enabled")
        .where("id", "=", appId)
        .forShare()
        .executeTakeFirst();
      if (!deployment?.enabled || deployment.adapter_id !== adapter.id || !app?.enabled) absent();
      const time = await databaseTime(tx),
        expiresAt = new Date(time.getTime() + this.transactionLifetimeMs);
      await tx
        .insertInto("session_transactions")
        .values({
          id,
          deployment_id: deploymentId,
          app_id: appId,
          initiation_verifier: initiationVerifier,
          state: "pending",
          state_verifier: null,
          browser_verifier: null,
          protected_state: null,
          expires_at: expiresAt,
          session_id: null,
          claim_token: null,
          claim_incarnation: null,
          claim_until: null,
        })
        .execute();
      return { id, expiresAt: expiresAt.toISOString() };
    });
  }
  async launch(
    id: string,
    proof: string,
  ): Promise<{ authorizationUrl: string; browserSecret: string }> {
    const hint = await this.db
      .selectFrom("session_transactions")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!hint) absent();
    if (!verifySecret(proof, hint.initiation_verifier)) throw authFailure();
    const adapter = this.adapters.get(hint.deployment_id);
    if (!adapter)
      throw new ServiceError(503, "adapter-unavailable", "Identity adapter unavailable");
    const started = await adapter.begin();
    const protectedState = this.secrets.seal(Buffer.from(JSON.stringify(started.protectedState)), {
      kind: "session-transaction",
      id,
      provider: adapter.id,
      revision: "1",
    });
    const browserSecret = randomSecret();
    await this.db.transaction().execute(async (tx) => {
      const deployment = await tx
        .selectFrom("deployments")
        .select("enabled")
        .where("id", "=", hint.deployment_id)
        .forShare()
        .executeTakeFirst();
      const app = await tx
        .selectFrom("apps")
        .select("enabled")
        .where("id", "=", hint.app_id)
        .forShare()
        .executeTakeFirst();
      const current = await tx
        .selectFrom("session_transactions")
        .selectAll()
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      const time = await databaseTime(tx);
      if (
        !deployment?.enabled ||
        !app?.enabled ||
        !current ||
        current.state !== "pending" ||
        current.expires_at <= time ||
        !verifySecret(proof, current.initiation_verifier)
      )
        stale();
      await tx
        .updateTable("session_transactions")
        .set({
          state: "launched",
          state_verifier: verifier(started.protectedState.state),
          browser_verifier: verifier(browserSecret),
          protected_state: protectedState,
        })
        .where("id", "=", id)
        .execute();
    });
    return { authorizationUrl: started.authorizationUrl, browserSecret };
  }
  async callback(
    adapterId: string,
    parameters: URLSearchParams,
    browserSecret: string | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    const states = parameters.getAll("state");
    if (states.length !== 1 || !states[0] || !browserSecret) throw authFailure();
    const hint = await this.db
      .selectFrom("session_transactions")
      .selectAll()
      .where("state_verifier", "=", verifier(states[0]))
      .executeTakeFirst();
    if (!hint) throw authFailure();
    const adapter = this.adapters.get(hint.deployment_id);
    if (!adapter || adapter.id !== adapterId) throw authFailure();
    const token = randomUUID();
    const claimed = await this.db.transaction().execute(async (tx) => {
      const deployment = await tx
        .selectFrom("deployments")
        .select("enabled")
        .where("id", "=", hint.deployment_id)
        .forShare()
        .executeTakeFirst();
      const app = await tx
        .selectFrom("apps")
        .select("enabled")
        .where("id", "=", hint.app_id)
        .forShare()
        .executeTakeFirst();
      const current = await tx
        .selectFrom("session_transactions")
        .selectAll()
        .where("id", "=", hint.id)
        .forUpdate()
        .executeTakeFirst();
      const time = await databaseTime(tx);
      if (
        !deployment?.enabled ||
        !app?.enabled ||
        !current ||
        current.state !== "launched" ||
        current.expires_at <= time ||
        !current.browser_verifier ||
        !verifySecret(browserSecret, current.browser_verifier) ||
        !current.protected_state
      )
        throw authFailure();
      await tx
        .updateTable("session_transactions")
        .set({
          state: "exchanging",
          claim_token: token,
          claim_incarnation: this.incarnation,
          claim_until: current.expires_at,
        })
        .where("id", "=", current.id)
        .execute();
      return current;
    });
    try {
      const plaintext = this.secrets.open(claimed.protected_state, {
        kind: "session-transaction",
        id: hint.id,
        provider: adapter.id,
        revision: "1",
      });
      let state: AdapterState;
      try {
        state = adapterStateSchema.parse(JSON.parse(plaintext.toString()));
      } finally {
        plaintext.fill(0);
      }
      const identity = await adapter.complete(state, parameters, signal);
      if (identity.deploymentId !== hint.deployment_id || identity.adapterId !== adapter.id)
        throw authFailure();
      await this.db.transaction().execute(async (tx) => {
        const access = await this.access.publishIdentity(tx, identity, hint.app_id);
        const current = await tx
          .selectFrom("session_transactions")
          .selectAll()
          .where("id", "=", hint.id)
          .forUpdate()
          .executeTakeFirst();
        const time = await databaseTime(tx);
        if (
          !current ||
          current.state !== "exchanging" ||
          current.claim_token !== token ||
          current.claim_incarnation !== this.incarnation ||
          !current.claim_until ||
          current.claim_until <= time ||
          current.expires_at <= time
        )
          stale();
        await tx
          .updateTable("session_transactions")
          .set({
            state: "succeeded",
            session_id: access.sessionId,
            protected_state: null,
            claim_token: null,
            claim_incarnation: null,
            claim_until: null,
          })
          .where("id", "=", hint.id)
          .execute();
      });
      return hint.id;
    } catch (error) {
      await this.db
        .updateTable("session_transactions")
        .set({
          state: "failed",
          protected_state: null,
          claim_token: null,
          claim_incarnation: null,
          claim_until: null,
        })
        .where("id", "=", hint.id)
        .where("claim_token", "=", token)
        .where("claim_incarnation", "=", this.incarnation)
        .where("state", "=", "exchanging")
        .execute();
      throw error;
    }
  }
  async redeem(id: string, proof: string): Promise<{ response: SessionResponse; cookie: string }> {
    const hint = await this.db
      .selectFrom("session_transactions")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!hint?.session_id) throw authFailure();
    const token = randomSecret(),
      restoration = randomSecret();
    return this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom("sessions as s")
        .innerJoin("owners as o", "o.id", "s.owner_id")
        .select([
          "o.id as ownerId",
          "o.deployment_id as deploymentId",
          "o.site_id as siteId",
          "o.subject_id as subjectId",
          "s.id as sessionId",
          "s.authentication_expires_at as authenticationExpiresAt",
        ])
        .where("s.id", "=", hint.session_id)
        .executeTakeFirst();
      if (!row) throw authFailure();
      const access = { ...row, appId: hint.app_id };
      await this.access.lockAuthority(tx, access);
      const current = await tx
        .selectFrom("session_transactions")
        .selectAll()
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      const time = await databaseTime(tx);
      if (
        !current ||
        current.state !== "succeeded" ||
        current.session_id !== row.sessionId ||
        current.expires_at <= time ||
        !verifySecret(proof, current.initiation_verifier)
      )
        throw authFailure();
      const expiresAt = await this.access.issueAccess(tx, access, token);
      await tx
        .insertInto("restoration_bindings")
        .values({
          verifier: verifier(restoration),
          session_id: access.sessionId,
          browser_profile: "partitioned-service-cookie-v1",
        })
        .execute();
      await tx
        .updateTable("session_transactions")
        .set({ state: "redeemed", browser_verifier: null })
        .where("id", "=", id)
        .execute();
      return {
        response: response(access, token, expiresAt),
        cookie: `${restorationCookieName(access.deploymentId)}=${restoration}; Secure; HttpOnly; SameSite=None; Partitioned; Path=/; Max-Age=${Math.max(0, Math.floor((access.authenticationExpiresAt.getTime() - time.getTime()) / 1000))}`,
      };
    });
  }
  async restore(
    appId: string,
    deploymentId: string,
    secret: string | undefined,
  ): Promise<SessionResponse> {
    if (!secret) throw authFailure();
    const hint = await this.db
      .selectFrom("restoration_bindings as b")
      .innerJoin("sessions as s", "s.id", "b.session_id")
      .innerJoin("owners as o", "o.id", "s.owner_id")
      .select([
        "b.verifier",
        "o.id as ownerId",
        "o.deployment_id as deploymentId",
        "o.site_id as siteId",
        "o.subject_id as subjectId",
        "s.id as sessionId",
        "s.authentication_expires_at as authenticationExpiresAt",
      ])
      .where("b.verifier", "=", verifier(secret))
      .executeTakeFirst();
    if (!hint || hint.deploymentId !== deploymentId) throw authFailure();
    const token = randomSecret();
    return this.db.transaction().execute(async (tx) => {
      const access = { ...hint, appId };
      await this.access.lockAuthority(tx, access);
      const current = await tx
        .selectFrom("restoration_bindings")
        .select("session_id")
        .where("verifier", "=", hint.verifier)
        .forShare()
        .executeTakeFirst();
      if (current?.session_id !== access.sessionId) throw authFailure();
      const expiresAt = await this.access.issueAccess(tx, access, token);
      return response(access, token, expiresAt);
    });
  }
  async maintenance(batch: number): Promise<void> {
    if (!Number.isSafeInteger(batch) || batch < 1) throw new Error("Invalid maintenance batch");
    await sql`delete from access_tokens where verifier in (select verifier from access_tokens where expires_at<=clock_timestamp() order by expires_at limit ${batch})`.execute(
      this.db,
    );
    await sql`delete from session_transactions where id in (select id from session_transactions where expires_at<=clock_timestamp() order by expires_at limit ${batch})`.execute(
      this.db,
    );
  }
}
