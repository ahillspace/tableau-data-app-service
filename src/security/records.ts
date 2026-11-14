import { sql } from "kysely";
import type { Database } from "../db/database.js";
import { type EncryptedEnvelope, type SecretBinding, SecretBox } from "./encryption.js";

type RecordMetadata = {
  table: string;
  id: string;
  subkey: string;
  key_id: string;
  bytes: number;
  kind: string;
  provider: string;
  revision: string;
};
const jsonColumns = new Map([
  ["connections", "bundle"],
  ["session_transactions", "protected_state"],
  ["authorizations", "protected_state"],
  ["event_sources", "private_context"],
]);
// Every protected persistence owner is enumerated here. High-entropy verifiers
// and transient encrypted Job continuations are deliberately not stored bodies.
const recordQueries = new Map([
  [
    "connections",
    sql`select id,'' as subkey,bundle->>'keyId' as key_id,length(bundle->>'ciphertext')::int as bytes,'connection' as kind,provider_registration_id as provider,authority_generation::text||':'||credential_generation::text as revision from connections where bundle is not null`,
  ],
  [
    "session_transactions",
    sql`select t.id,'' as subkey,t.protected_state->>'keyId' as key_id,length(t.protected_state->>'ciphertext')::int as bytes,'session-transaction' as kind,d.adapter_id as provider,'1' as revision from session_transactions t join deployments d on d.id=t.deployment_id where t.protected_state is not null`,
  ],
  [
    "authorizations",
    sql`select id,'' as subkey,protected_state->>'keyId' as key_id,length(protected_state->>'ciphertext')::int as bytes,'authorization' as kind,provider_registration_id as provider,'1' as revision from authorizations where protected_state is not null`,
  ],
  [
    "event_sources",
    sql`select id,'' as subkey,private_context->>'keyId' as key_id,length(private_context->>'ciphertext')::int as bytes,'event-source' as kind,provider_registration_id as provider,revision::text from event_sources`,
  ],
  [
    "job_payloads",
    sql`select p.job_id as id,p.kind as subkey,p.key_id,octet_length(p.body)::int as bytes,'job-'||p.kind as kind,j.provider_registration_id as provider,p.revision from job_payloads p join jobs j on j.id=p.job_id`,
  ],
]);
async function metadata(db: Database, after?: RecordMetadata): Promise<RecordMetadata | undefined> {
  let reached = !after;
  for (const [table, query] of recordQueries) {
    if (!reached) {
      if (table !== after?.table) continue;
      reached = true;
    }
    const cursor = after?.table === table ? after : undefined;
    const row = (
      await sql<RecordMetadata>`select ${table}::text as "table", records.* from (${query}) records where (id,subkey)>(${cursor?.id ?? ""},${cursor?.subkey ?? ""}) order by id,subkey limit 1`.execute(
        db,
      )
    ).rows[0];
    if (row) return row;
  }
  return undefined;
}
const binding = (row: RecordMetadata): SecretBinding => ({
  kind: row.kind,
  id: row.id,
  provider: row.provider,
  revision: row.revision,
});
function reserve(row: RecordMetadata, workingBytes: number) {
  if (
    !Number.isSafeInteger(workingBytes) ||
    workingBytes < 1 ||
    row.bytes < 0 ||
    row.bytes * 12 > workingBytes
  )
    throw new Error("Protected record exceeds the configured maintenance working-byte budget");
}
async function load(db: Database, row: RecordMetadata): Promise<EncryptedEnvelope> {
  if (row.table === "job_payloads") {
    const value = (
      await sql<{
        key_id: string;
        nonce: Buffer;
        tag: Buffer;
        body: Buffer;
      }>`select key_id,nonce,tag,body from job_payloads where job_id=${row.id} and kind=${row.subkey}`.execute(
        db,
      )
    ).rows[0];
    if (!value) throw new Error("Protected record changed");
    return {
      v: 1,
      keyId: value.key_id,
      nonce: value.nonce.toString("base64url"),
      tag: value.tag.toString("base64url"),
      ciphertext: value.body.toString("base64url"),
    };
  }
  const column = jsonColumns.get(row.table);
  if (!column) throw new Error("Unknown protected record owner");
  const value = (
    await sql<{
      envelope: EncryptedEnvelope;
    }>`select ${sql.ref(column)} as envelope from ${sql.table(row.table)} where id=${row.id}`.execute(
      db,
    )
  ).rows[0];
  if (!value?.envelope) throw new Error("Protected record changed");
  return value.envelope;
}
async function replace(
  db: Database,
  row: RecordMetadata,
  previous: EncryptedEnvelope,
  next: EncryptedEnvelope,
): Promise<void> {
  const result =
    row.table === "job_payloads"
      ? await sql`update job_payloads set key_id=${next.keyId},nonce=${Buffer.from(next.nonce, "base64url")},tag=${Buffer.from(next.tag, "base64url")},body=${Buffer.from(next.ciphertext, "base64url")} where job_id=${row.id} and kind=${row.subkey} and key_id=${previous.keyId} and nonce=${Buffer.from(previous.nonce, "base64url")} and tag=${Buffer.from(previous.tag, "base64url")}`.execute(
          db,
        )
      : await sql`update ${sql.table(row.table)} set ${sql.ref(jsonColumns.get(row.table)!)}=${JSON.stringify(next)}::jsonb where id=${row.id} and ${sql.ref(jsonColumns.get(row.table)!)}=${JSON.stringify(previous)}::jsonb`.execute(
          db,
        );
  if (result.numAffectedRows !== 1n) throw new Error("Protected record changed during maintenance");
}
export async function verifyProtectedKeys(
  db: Database,
  box: SecretBox,
  keys: ReadonlyMap<string, Buffer>,
  workingBytes: number,
): Promise<void> {
  const seen = new Set<string>();
  let after: RecordMetadata | undefined;
  while (true) {
    const row = await metadata(db, after);
    if (!row) return;
    after = row;
    if (!keys.has(row.key_id)) throw new Error("Required protected-record key is missing");
    if (!seen.has(row.key_id)) {
      reserve(row, workingBytes);
      const plaintext = box.open(await load(db, row), binding(row));
      plaintext.fill(0);
      seen.add(row.key_id);
    }
  }
}
async function assertWritersStopped(db: Database): Promise<void> {
  const writers = (
    await sql<{
      present: boolean;
    }>`select exists(select 1 from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and application_name in ('integration-api','integration-control')) as present`.execute(
      db,
    )
  ).rows[0];
  if (writers?.present)
    throw new Error("API, worker or command database sessions are still present");
}
export async function reencryptProtectedRecords(
  db: Database,
  box: SecretBox,
  options: {
    from: string;
    to: string;
    workingBytes: number;
    writersStopped: boolean;
    afterRecord?(): Promise<void>;
  },
): Promise<{ verified: number; changed: number }> {
  if (!options.writersStopped || options.from === options.to)
    throw new Error("Offline writer exclusion and distinct keys are required");
  return db.connection().execute(async (connection) => {
    const locked = (
      await sql<{ locked: boolean }>`select pg_try_advisory_lock(946729401,1) as locked`.execute(
        connection,
      )
    ).rows[0]?.locked;
    if (!locked) throw new Error("Another protected-record maintenance command is active");
    try {
      await assertWritersStopped(connection);
      let after: RecordMetadata | undefined;
      let verified = 0,
        changed = 0;
      while (true) {
        const row = await metadata(connection, after);
        if (!row) break;
        after = row;
        if (![options.from, options.to].includes(row.key_id))
          throw new Error("Unexpected protected-record key; preserve evidence before proceeding");
        reserve(row, options.workingBytes);
        await assertWritersStopped(connection);
        const previous = await load(connection, row);
        const plaintext = box.open(previous, binding(row));
        try {
          if (previous.keyId === options.from) {
            const next = box.seal(plaintext, binding(row), options.to);
            const probe = box.open(next, binding(row));
            probe.fill(0);
            await replace(connection, row, previous, next);
            changed++;
          }
        } finally {
          plaintext.fill(0);
        }
        verified++;
        await options.afterRecord?.();
      }
      await assertWritersStopped(connection);
      // A second metadata pass catches reintroduced old keys before completion.
      after = undefined;
      while (true) {
        const row = await metadata(connection, after);
        if (!row) break;
        after = row;
        if (row.key_id !== options.to)
          throw new Error("Protected-record key coverage is incomplete");
      }
      return { verified, changed };
    } finally {
      await sql`select pg_advisory_unlock(946729401,1)`.execute(connection);
    }
  });
}
