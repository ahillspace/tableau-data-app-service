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

export type AuditEntry = {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  detail: unknown;
};

/** Audit entries, newest first. `before` pages backwards from an entry ID, which only grows. */
export async function listAudit(
  db: Queryable,
  filter: { limit?: number | undefined; before?: string | undefined } = {},
): Promise<AuditEntry[]> {
  let query = db
    .selectFrom("audit")
    .selectAll()
    .orderBy("id", "desc")
    .limit(Math.min(Math.max(filter.limit ?? 100, 1), 1000));
  if (filter.before !== undefined) {
    if (!/^\d{1,19}$/.test(filter.before)) throw invalid([{ path: "before", rule: "audit-id" }]);
    query = query.where("id", "<", filter.before);
  }
  const rows = await query.execute();
  return rows.map((r) => ({
    id: String(r.id),
    at: r.at.toISOString(),
    actor: r.actor,
    action: r.action,
    target: r.target,
    detail: r.detail,
  }));
}
