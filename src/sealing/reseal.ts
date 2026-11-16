import { sql } from "kysely";
import type { Db } from "../persistence/database.ts";
import type { SealedJson } from "../persistence/schema.ts";
import type { Sealer, SealPurpose } from "./sealer.ts";

export type ResealReport = { resealed: number; remaining: number };

const PURPOSE_BY_FIELD: Record<string, SealPurpose> = {
  clientSecret: "client-secret",
  signingSecret: "signing-secret",
  credential: "credential",
};

export function definitionSecretRecordId(definitionId: string, field: string): string {
  return `${definitionId}/${field}`;
}

/**
 * Reseals every sealed value with the current key while the service runs.
 * Each row is replaced with a compare-and-swap on its old sealed value, so a concurrent write wins.
 * A second pass confirms no value still names an old key. Safe to rerun.
 */
export async function reseal(db: Db, sealer: Sealer, batch = 200): Promise<ResealReport> {
  const current = sealer.currentKeyId;
  let resealed = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (;;) {
      const rows = await db
        .selectFrom("definition_secrets")
        .select(["definition_id", "field", "sealed"])
        .where(sql<boolean>`sealed->>'keyId' <> ${current}`)
        .limit(batch)
        .execute();
      if (!rows.length) break;
      for (const row of rows) {
        const purpose = PURPOSE_BY_FIELD[row.field] as SealPurpose;
        const recordId = definitionSecretRecordId(row.definition_id, row.field);
        const next = sealer.seal(purpose, recordId, sealer.open(purpose, recordId, row.sealed));
        const result = await db
          .updateTable("definition_secrets")
          .set({ sealed: JSON.stringify(next) })
          .where("definition_id", "=", row.definition_id)
          .where("field", "=", row.field)
          .where(sql<boolean>`sealed = ${JSON.stringify(row.sealed)}::jsonb`)
          .executeTakeFirst();
        if (result.numUpdatedRows > 0n) resealed++;
      }
    }
    for (;;) {
      const rows = await db
        .selectFrom("connections")
        .select(["id", "sealed"])
        .where("sealed", "is not", null)
        .where(sql<boolean>`sealed->>'keyId' <> ${current}`)
        .limit(batch)
        .execute();
      if (!rows.length) break;
      for (const row of rows) {
        const sealed = row.sealed as SealedJson;
        const next = sealer.seal("credential", row.id, sealer.open("credential", row.id, sealed));
        const result = await db
          .updateTable("connections")
          .set({ sealed: JSON.stringify(next) })
          .where("id", "=", row.id)
          .where(sql<boolean>`sealed = ${JSON.stringify(sealed)}::jsonb`)
          .executeTakeFirst();
        if (result.numUpdatedRows > 0n) resealed++;
      }
    }
  }
  const remaining = await sql<{ n: string }>`
    select (select count(*) from definition_secrets where sealed->>'keyId' <> ${current})
         + (select count(*) from connections where sealed is not null and sealed->>'keyId' <> ${current}) as n
  `.execute(db);
  return { resealed, remaining: Number(remaining.rows[0]?.n ?? 0) };
}
