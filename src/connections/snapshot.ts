import { performance } from "node:perf_hooks";
import { sql } from "kysely";
import { type AccessRow, accessContext, authFailure } from "../access/service.js";
import type { AccessContext, ConnectionUse, CredentialSnapshot } from "../core-ports.js";
import type { Database } from "../db/database.js";
import { absent, ServiceError } from "../http/errors.js";
import type { ProviderRegistration } from "../providers/registry.js";
import type { EncryptedEnvelope, SecretBox } from "../security/encryption.js";
import { verifier } from "../security/secrets.js";

type SnapshotRow = AccessRow & {
  server_time: Date;
  access_expires_at: Date;
  config_revision: number;
  mode: string;
  reauth_seconds: number | null;
  connection_id: string | null;
  state: string | null;
  authority_generation: number | null;
  credential_generation: number | null;
  last_connector_reauth_at: Date | null;
  credential_expires_at: Date | null;
  bundle: EncryptedEnvelope | null;
  may_invalidate: boolean | null;
};
export type PreparedRequest = {
  access: AccessContext;
  use: ConnectionUse | null;
  needsRenewal: boolean;
  take(): CredentialSnapshot | null;
};
export async function prepareRequest(
  db: Database,
  secrets: SecretBox,
  provider: ProviderRegistration,
  appId: string,
  authentication: { token: string } | { access: AccessContext },
  connectionId?: string,
  allowRenewal = false,
): Promise<PreparedRequest> {
  const sampled = performance.now();
  const identity =
    "token" in authentication
      ? sql`t.verifier=${verifier(authentication.token)} and t.expires_at>clock_timestamp()`
      : sql`s.id=${authentication.access.sessionId} and s.owner_id=${authentication.access.ownerId}`;
  const rows = (
    await sql<SnapshotRow>`
    select o.id as owner_id,o.deployment_id,o.site_id,o.subject_id,s.id as session_id,s.authentication_expires_at,
      clock_timestamp() as server_time,least(s.authentication_expires_at,coalesce(t.expires_at,s.authentication_expires_at)) as access_expires_at,
      p.config_revision,p.mode,p.reauth_seconds,c.id as connection_id,c.state,c.authority_generation,c.credential_generation,
      c.last_connector_reauth_at,c.credential_expires_at,c.bundle,m.may_invalidate
    from sessions s join owners o on o.id=s.owner_id
    left join access_tokens t on t.session_id=s.id and ${"token" in authentication ? sql`t.verifier=${verifier(authentication.token)}` : sql`false`}
    join tableau_sites ts on ts.deployment_id=o.deployment_id and ts.site_id=o.site_id
    join deployments d on d.id=o.deployment_id join apps a on a.id=${appId}
    join provider_registrations p on p.id=${provider.id}
    left join lateral (
      select candidate.* from connections candidate where p.mode<>'none' and candidate.provider_registration_id=p.id
      and (case when ${connectionId ?? null}::text is not null then candidate.id=${connectionId ?? null}
           when a.defaults->>p.id is not null then candidate.id=a.defaults->>p.id else true end)
      and ((p.mode='personal' and candidate.owner_id=o.id) or (p.mode='operator' and candidate.owner_id is null and exists(
        select 1 from connection_audience ca where ca.connection_id=candidate.id and ca.deployment_id=o.deployment_id
        and ca.site_id=o.site_id and ca.subject_id in ('*',o.subject_id))))
      order by candidate.id limit 2
    ) c on true left join credential_mutations m on m.id=c.mutation_id
    where ${identity} and not s.revoked and s.authentication_expires_at>clock_timestamp()
    and ts.enabled and d.enabled and a.enabled and p.enabled
  `.execute(db)
  ).rows;
  const row = rows[0];
  if (!row) throw authFailure();
  if (row.config_revision !== provider.revision || row.mode !== provider.mode)
    throw new ServiceError(
      503,
      "configuration-incompatible",
      "Provider configuration is unavailable",
    );
  const access = accessContext(row, appId);
  if (provider.mode === "none" && connectionId)
    throw new ServiceError(400, "irrelevant-connection", "This provider does not use a connection");
  if (provider.mode !== "none" && !row.connection_id) {
    if (connectionId) absent();
    throw new ServiceError(422, "connection-required", "Choose a connection");
  }
  if (rows.length > 1)
    throw new ServiceError(422, "connection-required", "Choose an explicit connection");
  let expiry = row.access_expires_at.getTime() - row.server_time.getTime();
  let use: ConnectionUse | null = null;
  const needsRenewal =
    (!!row.credential_expires_at && row.credential_expires_at <= row.server_time) ||
    (!!row.may_invalidate && allowRenewal);
  if (row.connection_id) {
    if (row.state !== "active" || !row.bundle || (row.may_invalidate && !allowRenewal))
      throw new ServiceError(
        422,
        row.state === "renewal-uncertain" || row.may_invalidate
          ? "renewal-uncertain"
          : "reauthorization-required",
        "Connection is unavailable",
      );
    if (row.reauth_seconds !== null) {
      if (!row.last_connector_reauth_at)
        throw new ServiceError(
          422,
          "reauthorization-required",
          "Connector reauthorization required",
        );
      expiry = Math.min(
        expiry,
        row.last_connector_reauth_at.getTime() +
          row.reauth_seconds * 1000 -
          row.server_time.getTime(),
      );
    }
    if (row.credential_expires_at && !(needsRenewal && allowRenewal))
      expiry = Math.min(expiry, row.credential_expires_at.getTime() - row.server_time.getTime());
    if (expiry <= 0)
      throw new ServiceError(422, "reauthorization-required", "Connector reauthorization required");
    use = {
      authority: { source: "request", access },
      connectionId: row.connection_id,
      providerRegistrationId: provider.id,
      authorityGeneration: row.authority_generation ?? 0,
    };
  }
  let consumed = false;
  return {
    access,
    use,
    needsRenewal,
    take() {
      if (consumed) throw new Error("Request snapshot was already consumed");
      consumed = true;
      if (needsRenewal)
        throw new ServiceError(422, "reauthorization-required", "Provider credential expired");
      if (performance.now() - sampled >= expiry) throw authFailure();
      if (!row.connection_id || !row.bundle) return null;
      const plaintext = secrets.open(row.bundle, {
        kind: "connection",
        id: row.connection_id,
        provider: provider.id,
        revision: `${row.authority_generation}:${row.credential_generation}`,
      });
      try {
        const parsed = JSON.parse(plaintext.toString()) as {
          credentials: unknown;
          runtimeContext: unknown;
        };
        const snapshot = {
          authorityGeneration: row.authority_generation ?? 0,
          credentialGeneration: row.credential_generation ?? 0,
          expiresAt: row.credential_expires_at,
          credentials: provider.credentialsSchema.parse(parsed.credentials),
          runtimeContext: provider.contextSchema.parse(parsed.runtimeContext),
        };
        if (performance.now() - sampled >= expiry) throw authFailure();
        return snapshot;
      } finally {
        plaintext.fill(0);
      }
    },
  };
}
