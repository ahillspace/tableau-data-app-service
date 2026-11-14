import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Config } from "../config.js";
import type { AccessContext, AccessPort, VerifiedIdentity } from "../core-ports.js";
import { type CoreTransaction, type Database, databaseTime } from "../db/database.js";
import { ServiceError } from "../http/errors.js";
import { randomSecret, verifier } from "../security/secrets.js";

export const authFailure = () =>
  new ServiceError(401, "authentication-required", "Verified authentication required");
export class AccessService implements AccessPort {
  constructor(
    readonly db: Database,
    readonly config: Config,
  ) {}

  async authenticate(token: string, appId: string): Promise<AccessContext> {
    if (token.length > 200) throw authFailure();
    const result =
      await sql<AccessRow>`select o.id as owner_id, o.deployment_id, o.site_id, o.subject_id,
      s.id as session_id, s.authentication_expires_at
      from access_tokens t join sessions s on s.id=t.session_id join owners o on o.id=s.owner_id
      join tableau_sites ts on ts.deployment_id=o.deployment_id and ts.site_id=o.site_id
      join deployments d on d.id=o.deployment_id join apps a on a.id=${appId}
      where t.verifier=${verifier(token)} and t.expires_at>clock_timestamp()
      and not s.revoked and s.authentication_expires_at>clock_timestamp()
      and ts.enabled and d.enabled and a.enabled`.execute(this.db);
    const row = result.rows[0];
    if (!row) throw authFailure();
    return accessContext(row, appId);
  }

  async lockAuthority(
    tx: CoreTransaction,
    access: AccessContext,
    registrationId?: string,
  ): Promise<void> {
    const deployment = await tx
      .selectFrom("deployments")
      .select("enabled")
      .where("id", "=", access.deploymentId)
      .forShare()
      .executeTakeFirst();
    const site = await tx
      .selectFrom("tableau_sites")
      .select("enabled")
      .where("deployment_id", "=", access.deploymentId)
      .where("site_id", "=", access.siteId)
      .forShare()
      .executeTakeFirst();
    if (!deployment?.enabled || !site?.enabled)
      throw new ServiceError(403, "site-disabled", "Site is not enabled");
    if (registrationId) {
      const provider = await tx
        .selectFrom("provider_registrations")
        .select("enabled")
        .where("id", "=", registrationId)
        .forShare()
        .executeTakeFirst();
      if (!provider?.enabled) throw new ServiceError(404, "not-found", "Provider not found");
    }
    const app = await tx
      .selectFrom("apps")
      .select("enabled")
      .where("id", "=", access.appId)
      .forShare()
      .executeTakeFirst();
    if (!app?.enabled) throw new ServiceError(404, "not-found", "App not found");
    const session = await tx
      .selectFrom("sessions")
      .selectAll()
      .where("id", "=", access.sessionId)
      .forShare()
      .executeTakeFirst();
    const time = await databaseTime(tx);
    if (
      !session ||
      session.owner_id !== access.ownerId ||
      session.revoked ||
      session.authentication_expires_at <= time
    )
      throw authFailure();
  }

  async publishIdentity(
    tx: CoreTransaction,
    identity: VerifiedIdentity,
    appId: string,
  ): Promise<AccessContext> {
    const sessionId = randomUUID();
    const deployment = await tx
      .selectFrom("deployments")
      .selectAll()
      .where("id", "=", identity.deploymentId)
      .forShare()
      .executeTakeFirst();
    const site = await tx
      .selectFrom("tableau_sites")
      .selectAll()
      .where("deployment_id", "=", identity.deploymentId)
      .where("site_id", "=", identity.siteId)
      .forShare()
      .executeTakeFirst();
    if (!deployment?.enabled || deployment.adapter_id !== identity.adapterId || !site?.enabled)
      throw new ServiceError(403, "site-disabled", "Site is not enabled");
    const app = await tx
      .selectFrom("apps")
      .select("enabled")
      .where("id", "=", appId)
      .forShare()
      .executeTakeFirst();
    if (!app?.enabled) throw new ServiceError(404, "not-found", "App not found");
    const time = await databaseTime(tx);
    const expiresAt = new Date(
      identity.verifiedAt.getTime() + this.config.SESSION_MAX_AGE_SECONDS * 1000,
    );
    if (!Number.isFinite(expiresAt.getTime()) || identity.verifiedAt > time || expiresAt <= time)
      throw authFailure();
    await tx
      .insertInto("owners")
      .values({
        id: randomUUID(),
        deployment_id: identity.deploymentId,
        site_id: identity.siteId,
        subject_id: identity.subjectId,
      })
      .onConflict((conflict) =>
        conflict.columns(["deployment_id", "site_id", "subject_id"]).doNothing(),
      )
      .execute();
    const owner = await tx
      .selectFrom("owners")
      .select("id")
      .where("deployment_id", "=", identity.deploymentId)
      .where("site_id", "=", identity.siteId)
      .where("subject_id", "=", identity.subjectId)
      .executeTakeFirstOrThrow();
    await tx
      .insertInto("sessions")
      .values({
        id: sessionId,
        owner_id: owner.id,
        verified_at: identity.verifiedAt,
        authentication_expires_at: expiresAt,
        adapter_id: identity.adapterId,
      })
      .execute();

    return {
      ownerId: owner.id,
      deploymentId: identity.deploymentId,
      siteId: identity.siteId,
      subjectId: identity.subjectId,
      sessionId,
      authenticationExpiresAt: expiresAt,
      appId,
    };
  }
  async issueAccess(tx: CoreTransaction, access: AccessContext, token: string): Promise<Date> {
    const time = await databaseTime(tx);
    const expiresAt = new Date(
      Math.min(
        access.authenticationExpiresAt.getTime(),
        time.getTime() + this.config.ACCESS_TOKEN_AGE_SECONDS * 1000,
      ),
    );
    if (expiresAt <= time) throw authFailure();
    await tx
      .insertInto("access_tokens")
      .values({ verifier: verifier(token), session_id: access.sessionId, expires_at: expiresAt })
      .execute();
    return expiresAt;
  }
  async createSession(
    identity: VerifiedIdentity,
    appId: string,
  ): Promise<{ token: string; access: AccessContext; sessionId: string }> {
    const token = randomSecret();
    const access = await this.db.transaction().execute(async (tx) => {
      const access = await this.publishIdentity(tx, identity, appId);
      await this.issueAccess(tx, access, token);
      return access;
    });
    return { token, access, sessionId: access.sessionId };
  }

  async connectionVisible(access: AccessContext, connectionId: string): Promise<boolean> {
    const result = await sql<{ visible: boolean }>`select exists(select 1 from connections c
      where c.id=${connectionId} and (c.owner_id=${access.ownerId} or (c.owner_id is null and exists(
        select 1 from connection_audience ca where ca.connection_id=c.id and ca.deployment_id=${access.deploymentId}
        and ca.site_id=${access.siteId} and ca.subject_id in ('*',${access.subjectId}))))) as visible`.execute(
      this.db,
    );
    return result.rows[0]?.visible === true;
  }
}
export interface AccessRow {
  owner_id: string;
  deployment_id: string;
  site_id: string;
  subject_id: string;
  session_id: string;
  authentication_expires_at: Date;
}
export function accessContext(row: AccessRow, appId: string): AccessContext {
  return {
    ownerId: row.owner_id,
    deploymentId: row.deployment_id,
    siteId: row.site_id,
    subjectId: row.subject_id,
    sessionId: row.session_id,
    authenticationExpiresAt: row.authentication_expires_at,
    appId,
  };
}
export function bearer(value: string | undefined): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value ?? "");
  if (!match?.[1]) throw authFailure();
  return match[1];
}
