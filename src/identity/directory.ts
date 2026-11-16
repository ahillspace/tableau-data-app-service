import { sql } from "kysely";
import { writeAudit } from "../persistence/audit.ts";
import {
  type Db,
  isUniqueViolation,
  type Queryable,
  type Tx,
  transaction,
} from "../persistence/database.ts";
import { bumpRevision } from "../persistence/revision.ts";
import type { Bootstrap } from "../platform/bootstrap.ts";
import { invalid, notFound, ServiceError } from "../platform/errors.ts";
import type { Log } from "../platform/log.ts";
import type { Identity } from "./types.ts";

/**
 * Deployments, trusted sites and operators.
 * Sites and operators are first named and bind to Tableau's IDs on the first verified sign-in;
 * after binding only the IDs are matched.
 */

export type TrustedSite = {
  id: string;
  deploymentId: string;
  contentUrl: string;
  siteId: string | null;
  enabled: boolean;
  boundAt: Date | null;
  createdAt: Date;
};

export type Operator = {
  id: string;
  deploymentId: string;
  siteContentUrl: string;
  username: string;
  siteId: string | null;
  userId: string | null;
  boundAt: Date | null;
  createdAt: Date;
};

const CONTENT_URL = /^[A-Za-z0-9_-]{0,255}$/;

function siteRow(row: {
  id: string;
  deployment_id: string;
  content_url: string;
  site_id: string | null;
  enabled: boolean;
  bound_at: Date | null;
  created_at: Date;
}): TrustedSite {
  return {
    id: row.id,
    deploymentId: row.deployment_id,
    contentUrl: row.content_url,
    siteId: row.site_id,
    enabled: row.enabled,
    boundAt: row.bound_at,
    createdAt: row.created_at,
  };
}

function operatorRow(row: {
  id: string;
  deployment_id: string;
  site_content_url: string;
  username: string;
  site_id: string | null;
  user_id: string | null;
  bound_at: Date | null;
  created_at: Date;
}): Operator {
  return {
    id: row.id,
    deploymentId: row.deployment_id,
    siteContentUrl: row.site_content_url,
    username: row.username,
    siteId: row.site_id,
    userId: row.user_id,
    boundAt: row.bound_at,
    createdAt: row.created_at,
  };
}

/** Applies bootstrap: deployments always; the first site and operator only into empty tables. */
export async function applyBootstrap(db: Db, bootstrap: Bootstrap, log: Log): Promise<void> {
  await transaction(db, async (tx) => {
    await sql`select pg_advisory_xact_lock(7342001)`.execute(tx);
    for (const d of bootstrap.deployments) {
      await tx
        .insertInto("deployments")
        .values({ id: d.id, kind: d.kind, pod_origin: d.podOrigin, client_id: d.clientId })
        .onConflict((oc) =>
          oc
            .column("id")
            .doUpdateSet({ kind: d.kind, pod_origin: d.podOrigin, client_id: d.clientId }),
        )
        .execute();
    }
    const ignored: string[] = [];
    const sites = await tx
      .selectFrom("trusted_sites")
      .select(sql<number>`count(*)::int`.as("n"))
      .executeTakeFirstOrThrow();
    if (sites.n === 0) {
      await tx
        .insertInto("trusted_sites")
        .values({
          deployment_id: bootstrap.firstSite.deploymentId,
          content_url: bootstrap.firstSite.contentUrl,
          enabled: true,
        })
        .execute();
      await writeAudit(tx, {
        actor: "bootstrap",
        action: "site.add",
        target: bootstrap.firstSite.contentUrl,
      });
    } else {
      const named = await tx
        .selectFrom("trusted_sites")
        .select("id")
        .where("deployment_id", "=", bootstrap.firstSite.deploymentId)
        .where(sql`lower(content_url)`, "=", bootstrap.firstSite.contentUrl.toLowerCase())
        .executeTakeFirst();
      if (!named) ignored.push("firstSite");
    }
    const operators = await tx
      .selectFrom("operators")
      .select(sql<number>`count(*)::int`.as("n"))
      .executeTakeFirstOrThrow();
    const op = bootstrap.firstOperator;
    if (operators.n === 0) {
      await tx
        .insertInto("operators")
        .values({
          deployment_id: op.deploymentId,
          site_content_url: op.siteContentUrl,
          username: op.username,
        })
        .execute();
      await writeAudit(tx, {
        actor: "bootstrap",
        action: "operator.add",
        target: `${op.siteContentUrl}/${op.username}`,
      });
    } else {
      const named = await tx
        .selectFrom("operators")
        .select("id")
        .where("deployment_id", "=", op.deploymentId)
        .where(sql`lower(site_content_url)`, "=", op.siteContentUrl.toLowerCase())
        .where(sql`lower(username)`, "=", op.username.toLowerCase())
        .executeTakeFirst();
      if (!named) ignored.push("firstOperator");
    }
    if (sites.n === 0 || operators.n === 0) await bumpRevision(tx);
    if (ignored.length)
      log.info("bootstrap entries ignored because sites and operators are runtime data", {
        ignoredFields: ignored,
      });
  });
}

export async function deploymentIds(db: Queryable): Promise<string[]> {
  return (await db.selectFrom("deployments").select("id").orderBy("id").execute()).map((r) => r.id);
}

// ---- Trusted sites ----

export async function listSites(db: Queryable): Promise<TrustedSite[]> {
  return (await db.selectFrom("trusted_sites").selectAll().orderBy("created_at").execute()).map(
    siteRow,
  );
}

export async function addSite(
  db: Db,
  actor: string,
  input: { deploymentId: string; contentUrl: string },
): Promise<TrustedSite> {
  const fields = [];
  if (typeof input.deploymentId !== "string" || !input.deploymentId)
    fields.push({ path: "deploymentId", rule: "required" });
  if (typeof input.contentUrl !== "string" || !CONTENT_URL.test(input.contentUrl))
    fields.push({ path: "contentUrl", rule: "site-content-url" });
  if (fields.length) throw invalid(fields);
  return await transaction(db, async (tx) => {
    const deployment = await tx
      .selectFrom("deployments")
      .select("id")
      .where("id", "=", input.deploymentId)
      .executeTakeFirst();
    if (!deployment) throw invalid([{ path: "deploymentId", rule: "known-deployment" }]);
    try {
      const row = await tx
        .insertInto("trusted_sites")
        .values({ deployment_id: input.deploymentId, content_url: input.contentUrl, enabled: true })
        .returningAll()
        .executeTakeFirstOrThrow();
      await bumpRevision(tx);
      await writeAudit(tx, {
        actor,
        action: "site.add",
        target: row.id,
        detail: { deploymentId: input.deploymentId, contentUrl: input.contentUrl },
      });
      return siteRow(row);
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ServiceError(409, "site-exists", "That site is already trusted");
      throw error;
    }
  });
}

/** Enables or disables a trusted site. Disabling ends every session on it. */
export async function setSiteEnabled(
  db: Db,
  actor: string,
  id: string,
  enabled: boolean,
): Promise<TrustedSite> {
  return await transaction(db, async (tx) => {
    const row = await tx
      .updateTable("trusted_sites")
      .set({ enabled })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw notFound("site-not-found", "No such trusted site");
    if (!enabled) await endSiteSessions(tx, row.deployment_id, row.site_id);
    await bumpRevision(tx);
    await writeAudit(tx, { actor, action: enabled ? "site.enable" : "site.disable", target: id });
    return siteRow(row);
  });
}

export async function removeSite(db: Db, actor: string, id: string): Promise<void> {
  await transaction(db, async (tx) => {
    const row = await tx
      .deleteFrom("trusted_sites")
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw notFound("site-not-found", "No such trusted site");
    await endSiteSessions(tx, row.deployment_id, row.site_id);
    // Audiences name only sites that exist, so a removed site leaves every audience in the same transaction.
    await sql`update definitions set audience = audience - ${id}::text where audience ? ${id}::text`.execute(
      tx,
    );
    await bumpRevision(tx);
    await writeAudit(tx, {
      actor,
      action: "site.remove",
      target: id,
      detail: { contentUrl: row.content_url },
    });
  });
}

async function endSiteSessions(tx: Tx, deploymentId: string, siteId: string | null): Promise<void> {
  if (!siteId) return;
  await tx
    .deleteFrom("sign_in_sessions")
    .where("identity_id", "in", (q) =>
      q
        .selectFrom("identities")
        .select("id")
        .where("deployment_id", "=", deploymentId)
        .where("site_id", "=", siteId),
    )
    .execute();
}

/**
 * Finds the trusted site for a verified sign-in: by bound site ID, or before binding by content URL,
 * in which case the record binds to the site ID now. Returns undefined when the site is not trusted.
 */
export async function matchAndBindSite(
  tx: Tx,
  deploymentId: string,
  siteId: string,
  contentUrl: string,
): Promise<TrustedSite | undefined> {
  const bound = await tx
    .selectFrom("trusted_sites")
    .selectAll()
    .where("deployment_id", "=", deploymentId)
    .where("site_id", "=", siteId)
    .forUpdate()
    .executeTakeFirst();
  if (bound) return bound.enabled ? siteRow(bound) : undefined;
  const named = await tx
    .updateTable("trusted_sites")
    .set({ site_id: siteId, bound_at: new Date() })
    .where("deployment_id", "=", deploymentId)
    .where("site_id", "is", null)
    .where(sql`lower(content_url)`, "=", contentUrl.toLowerCase())
    .returningAll()
    .executeTakeFirst();
  if (!named) return undefined;
  await bumpRevision(tx);
  await writeAudit(tx, {
    actor: "sign-in",
    action: "site.bind",
    target: named.id,
    detail: { siteId },
  });
  return named.enabled ? siteRow(named) : undefined;
}

/** The enabled, bound trusted site for an identity, if it is still trusted. */
export async function trustedSiteFor(
  db: Queryable,
  identity: Identity,
): Promise<TrustedSite | undefined> {
  const row = await db
    .selectFrom("trusted_sites")
    .selectAll()
    .where("deployment_id", "=", identity.deploymentId)
    .where("site_id", "=", identity.siteId)
    .where("enabled", "=", true)
    .executeTakeFirst();
  return row ? siteRow(row) : undefined;
}

// ---- Operators ----

export async function listOperators(db: Queryable): Promise<Operator[]> {
  return (await db.selectFrom("operators").selectAll().orderBy("created_at").execute()).map(
    operatorRow,
  );
}

export async function addOperator(
  db: Db,
  actor: string,
  input: { deploymentId: string; siteContentUrl: string; username: string },
): Promise<Operator> {
  const fields = [];
  if (typeof input.deploymentId !== "string" || !input.deploymentId)
    fields.push({ path: "deploymentId", rule: "required" });
  if (typeof input.siteContentUrl !== "string" || !CONTENT_URL.test(input.siteContentUrl))
    fields.push({ path: "siteContentUrl", rule: "site-content-url" });
  if (typeof input.username !== "string" || !input.username || input.username.length > 500)
    fields.push({ path: "username", rule: "required" });
  if (fields.length) throw invalid(fields);
  return await transaction(db, async (tx) => {
    const deployment = await tx
      .selectFrom("deployments")
      .select("id")
      .where("id", "=", input.deploymentId)
      .executeTakeFirst();
    if (!deployment) throw invalid([{ path: "deploymentId", rule: "known-deployment" }]);
    try {
      const row = await tx
        .insertInto("operators")
        .values({
          deployment_id: input.deploymentId,
          site_content_url: input.siteContentUrl,
          username: input.username,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await bumpRevision(tx);
      await writeAudit(tx, {
        actor,
        action: "operator.add",
        target: row.id,
        detail: {
          deploymentId: input.deploymentId,
          siteContentUrl: input.siteContentUrl,
          username: input.username,
        },
      });
      return operatorRow(row);
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ServiceError(409, "operator-exists", "That operator is already named");
      throw error;
    }
  });
}

/** Removes an operator. The last operator cannot be removed through the API. */
export async function removeOperator(db: Db, actor: string, id: string): Promise<void> {
  await transaction(db, async (tx) => {
    await sql`lock table operators in share row exclusive mode`.execute(tx);
    const count = await tx
      .selectFrom("operators")
      .select(sql<number>`count(*)::int`.as("n"))
      .executeTakeFirstOrThrow();
    const row = await tx
      .selectFrom("operators")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) throw notFound("operator-not-found", "No such operator");
    if (count.n <= 1)
      throw new ServiceError(409, "last-operator", "The last operator cannot be removed");
    await tx.deleteFrom("operators").where("id", "=", id).execute();
    await bumpRevision(tx);
    await writeAudit(tx, { actor, action: "operator.remove", target: id });
  });
}

/** Binds a named operator record on that person's first verified sign-in. */
export async function bindOperator(
  tx: Tx,
  identity: Identity,
  siteContentUrl: string,
  userName: string,
): Promise<void> {
  const bound = await tx
    .selectFrom("operators")
    .select("id")
    .where("deployment_id", "=", identity.deploymentId)
    .where("site_id", "=", identity.siteId)
    .where("user_id", "=", identity.userId)
    .executeTakeFirst();
  if (bound) return;
  const named = await tx
    .updateTable("operators")
    .set({ site_id: identity.siteId, user_id: identity.userId, bound_at: new Date() })
    .where("deployment_id", "=", identity.deploymentId)
    .where("site_id", "is", null)
    .where(sql`lower(site_content_url)`, "=", siteContentUrl.toLowerCase())
    .where(sql`lower(username)`, "=", userName.toLowerCase())
    .returning("id")
    .executeTakeFirst();
  if (named) {
    await bumpRevision(tx);
    await writeAudit(tx, { actor: "sign-in", action: "operator.bind", target: named.id });
  }
}

/**
 * Operator status comes only from a bound operators record; no Tableau role grants it. With `hold`,
 * the record is share-locked until the caller's transaction ends, so a removal running at the same
 * time either commits first and is seen, or waits until the caller's change has committed.
 */
export async function isOperator(
  db: Queryable,
  identity: Identity,
  options: { hold?: boolean } = {},
): Promise<boolean> {
  const query = db
    .selectFrom("operators")
    .select("id")
    .where("deployment_id", "=", identity.deploymentId)
    .where("site_id", "=", identity.siteId)
    .where("user_id", "=", identity.userId);
  const row = await (options.hold ? query.forShare() : query).executeTakeFirst();
  return row !== undefined;
}
