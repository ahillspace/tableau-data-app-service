import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Queryable, Tx } from "../persistence/database.ts";
import type { SealedJson } from "../persistence/schema.ts";
import { ServiceError } from "../platform/errors.ts";
import { definitionSecretRecordId } from "../sealing/reseal.ts";
import type { Sealer } from "../sealing/sealer.ts";
import { placeCredential } from "./placement.ts";
import type { Account } from "./provider-types.ts";
import type {
  ConnectionDefinition,
  CredentialLease,
  SecretField,
  StoredCredential,
} from "./types.ts";

/** Opens a connection's sealed credential. The record ID is the connection ID, so a value cannot move between rows. */
export function openCredential(
  sealer: Sealer,
  connectionId: string,
  sealed: SealedJson,
): StoredCredential {
  const plain = sealer.open("credential", connectionId, sealed);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    throw new ServiceError(503, "credential-unavailable", "A stored credential is unreadable");
  }
  const value = parsed as Partial<StoredCredential>;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ServiceError(503, "credential-unavailable", "A stored credential is unreadable");
  return parsed as StoredCredential;
}

export function sealCredential(
  sealer: Sealer,
  connectionId: string,
  credential: StoredCredential,
): SealedJson {
  return sealer.seal("credential", connectionId, JSON.stringify(credential));
}

export function leaseFor(
  definition: ConnectionDefinition,
  connectionId: string | null,
  credential: StoredCredential | null,
): CredentialLease {
  return {
    definition,
    connectionId,
    apply(request) {
      if (credential) placeCredential(request, definition.credentialPlacement, credential);
    },
  };
}

export const SECRET_PURPOSE = {
  clientSecret: "client-secret",
  signingSecret: "signing-secret",
  signingPrivateKey: "signing-private-key",
} as const;

export async function readDefinitionSecret(
  db: Queryable,
  sealer: Sealer,
  definitionId: string,
  field: SecretField,
): Promise<string | undefined> {
  const row = await db
    .selectFrom("definition_secrets")
    .select("sealed")
    .where("definition_id", "=", definitionId)
    .where("field", "=", field)
    .executeTakeFirst();
  if (!row) return undefined;
  return sealer.open(
    SECRET_PURPOSE[field],
    definitionSecretRecordId(definitionId, field),
    row.sealed,
  );
}

export type NewConnection = {
  definition: ConnectionDefinition;
  ownerIdentityId: string | null;
  credential: StoredCredential;
  account: Account | null;
  scopes: string[];
  now: Date;
};

/**
 * Stores a connection for an owner, ending any live connection it replaces, in the caller's transaction.
 * The caller has already locked the definition row and confirmed its generation.
 */
export async function replaceConnection(
  tx: Tx,
  sealer: Sealer,
  input: NewConnection,
): Promise<string> {
  const { definition, ownerIdentityId, now } = input;
  // Two first connections for the same slot would both find nothing to end and race to insert;
  // the slot lock makes the second one end the first instead.
  await sql`select pg_advisory_xact_lock(hashtextextended(${`connection:${definition.id}:${ownerIdentityId ?? "shared"}`}, 0))`.execute(
    tx,
  );
  let ending = tx
    .updateTable("connections")
    .set({
      status: "disconnected",
      sealed: null,
      disconnected_at: now,
      disconnect_reason: "replaced",
      updated_at: now,
    })
    .where("definition_id", "=", definition.id)
    .where("status", "<>", "disconnected");
  ending =
    ownerIdentityId === null
      ? ending.where("owner_identity_id", "is", null)
      : ending.where("owner_identity_id", "=", ownerIdentityId);
  await ending.execute();
  const id = randomUUID();
  await tx
    .insertInto("connections")
    .values({
      id,
      definition_id: definition.id,
      generation: definition.generation,
      owner_identity_id: ownerIdentityId,
      status: "connected",
      sealed: JSON.stringify(sealCredential(sealer, id, input.credential)),
      account: input.account?.id ?? null,
      account_name: input.account?.name ?? null,
      scopes: JSON.stringify(input.scopes),
      authorized_at: now,
      credential_set_at: now,
      credential_expires_at: input.credential.expiresAt
        ? new Date(input.credential.expiresAt)
        : null,
      updated_at: now,
    })
    .execute();
  return id;
}

/** Locks a definition row and returns its live generation, or undefined when it is retired or gone. */
export async function lockDefinition(
  tx: Tx,
  id: string,
): Promise<{ generation: number; enabled: boolean } | undefined> {
  const row = await tx
    .selectFrom("definitions")
    .select(["generation", "enabled", "retired"])
    .where("id", "=", id)
    .forShare()
    .executeTakeFirst();
  if (!row || row.retired) return undefined;
  return { generation: row.generation, enabled: row.enabled };
}
