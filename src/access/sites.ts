import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import type { Database } from "../db/database.js";
import { absent, ServiceError } from "../http/errors.js";
import { opaqueId, siteInputSchema, siteViewSchema } from "../public/schemas.js";
import { verifySecret } from "../security/secrets.js";

export type RegistryCredential = { actorId: string; verifier: string };
export function registerSiteRoutes(
  app: FastifyInstance,
  db: Database,
  credentials: readonly RegistryCredential[],
): void {
  const authorize = (header: string | undefined): string => {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? "")?.[1];
    const credential = token && credentials.find((item) => verifySecret(token, item.verifier));
    if (!credential)
      throw new ServiceError(
        401,
        "registry-authentication-required",
        "Registry authentication required",
      );
    return credential.actorId;
  };
  const view = (row: {
    id: string;
    deployment_id: string;
    site_id: string;
    enabled: boolean;
    created_at: Date;
    updated_at: Date;
  }) =>
    siteViewSchema.parse({
      id: row.id,
      deploymentId: row.deployment_id,
      siteId: row.site_id,
      enabled: row.enabled,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    });
  app.get("/v1/admin/tableau-sites", async (request) => {
    authorize(request.headers.authorization);
    const query = z
      .strictObject({
        after: opaqueId.optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(request.query);
    const rows = await db
      .selectFrom("tableau_sites")
      .selectAll()
      .where("id", ">", query.after ?? "")
      .orderBy("id")
      .limit(query.limit + 1)
      .execute();
    return {
      items: rows.slice(0, query.limit).map(view),
      next: rows.length > query.limit ? rows[query.limit - 1]?.id : undefined,
    };
  });
  app.post("/v1/admin/tableau-sites", async (request, reply) => {
    const actor = authorize(request.headers.authorization);
    const input = siteInputSchema.parse(request.body);
    const result = await db.transaction().execute(async (tx) => {
      const deployment = await tx
        .selectFrom("deployments")
        .select("id")
        .where("id", "=", input.deploymentId)
        .forShare()
        .executeTakeFirst();
      if (!deployment) absent();
      const inserted = await tx
        .insertInto("tableau_sites")
        .values({
          id: randomUUID(),
          deployment_id: input.deploymentId,
          site_id: input.siteId,
          enabled: true,
        })
        .onConflict((conflict) => conflict.columns(["deployment_id", "site_id"]).doNothing())
        .returningAll()
        .executeTakeFirst();
      const row =
        inserted ??
        (await tx
          .selectFrom("tableau_sites")
          .selectAll()
          .where("deployment_id", "=", input.deploymentId)
          .where("site_id", "=", input.siteId)
          .executeTakeFirstOrThrow());
      if (inserted)
        await tx
          .insertInto("site_changes")
          .values({ id: randomUUID(), site_id: row.id, actor_id: actor, enabled: true })
          .execute();
      return { row, created: !!inserted };
    });
    reply.status(result.created ? 201 : 200);
    return view(result.row);
  });
  app.patch("/v1/admin/tableau-sites/:id", async (request) => {
    const actor = authorize(request.headers.authorization);
    const { id } = z.strictObject({ id: opaqueId }).parse(request.params);
    const input = z.strictObject({ enabled: z.boolean() }).parse(request.body);
    return db.transaction().execute(async (tx) => {
      const row = await tx
        .updateTable("tableau_sites")
        .set({ enabled: input.enabled, updated_at: sql`clock_timestamp()` })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirst();
      if (!row) absent();
      await tx
        .insertInto("site_changes")
        .values({ id: randomUUID(), site_id: id, actor_id: actor, enabled: input.enabled })
        .execute();
      return view(row);
    });
  });
}
