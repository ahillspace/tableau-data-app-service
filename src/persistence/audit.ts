import type { AuditEntry } from "../contracts/operator.ts";

export type { AuditEntry };

import { invalid } from "../platform/errors.ts";
import type { Queryable } from "./database.ts";

export async function writeAudit(
  db: Queryable,
  entry: {
    actor: string;
    action: string;
    target?: string | null;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .insertInto("audit")
    .values({
      actor: entry.actor,
      action: entry.action,
      target: entry.target ?? null,
      detail: JSON.stringify(entry.detail ?? {}),
    })
    .execute();
}

/** Audit entries, newest first. `before` pages backwards from an entry ID, which only grows. */
export async function listAudit(
  db: Queryable,
  filter: {
    limit?: number | undefined;
    before?: string | undefined;
    action?: string | undefined;
    definition?: string | undefined;
  } = {},
): Promise<AuditEntry[]> {
  let query = db
    .selectFrom("audit")
    .selectAll()
    .orderBy("id", "desc")
    .limit(Math.min(Math.max(filter.limit ?? 100, 1), 200));
  if (filter.before !== undefined) {
    if (!/^\d{1,19}$/.test(filter.before)) throw invalid([{ path: "before", rule: "audit-id" }]);
    query = query.where("id", "<", filter.before);
  }
  if (filter.action !== undefined) {
    if (!/^[a-z][a-z0-9.-]{0,99}$/.test(filter.action))
      throw invalid([{ path: "action", rule: "audit-action" }]);
    query = query.where("action", "=", filter.action);
  }
  if (filter.definition !== undefined) {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(filter.definition))
      throw invalid([{ path: "definition", rule: "definition-id" }]);
    query = query
      .where("target", "=", filter.definition)
      .where((eb) =>
        eb.or([eb("action", "like", "definition.%"), eb("action", "like", "connection.%")]),
      );
  }
  const rows = await query.execute();
  return rows.map((r) => ({
    id: String(r.id),
    at: r.at.toISOString(),
    actor: r.actor,
    action: r.action,
    subject: r.target,
    detail: r.detail,
  }));
}
