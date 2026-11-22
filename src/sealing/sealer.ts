import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SealedJson } from "../persistence/schema.ts";
import { ServiceError } from "../platform/errors.ts";
import type { SealingKeys } from "../platform/settings.ts";

export type SealPurpose =
  | "client-secret"
  | "signing-secret"
  | "signing-private-key"
  | "credential"
  | "storage-role"
  | "files-local-download";

function additionalData(purpose: SealPurpose, recordId: string, keyId: string): Buffer {
  return Buffer.from(JSON.stringify([1, purpose, recordId, keyId]));
}

function decode(value: unknown, length?: number): Buffer {
  if (typeof value !== "string") throw new Error("sealed-shape");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value || (length !== undefined && bytes.length !== length))
    throw new Error("sealed-shape");
  return bytes;
}

/** AES-256-GCM with the purpose, record ID and key ID bound as additional data. */
export class Sealer {
  readonly #keys: ReadonlyMap<string, Buffer>;
  readonly currentKeyId: string;

  constructor(keys: SealingKeys) {
    if (!keys.keys.has(keys.current)) throw new Error("The current sealing key is missing");
    for (const key of keys.keys.values())
      if (key.length !== 32) throw new Error("Sealing keys must be 256 bits");
    this.#keys = new Map([...keys.keys].map(([id, key]) => [id, Buffer.from(key)]));
    this.currentKeyId = keys.current;
    const probe = this.seal("credential", "startup-probe", "probe");
    if (this.open("credential", "startup-probe", probe) !== "probe")
      throw new Error("Sealing probe failed");
  }

  keyIds(): string[] {
    return [...this.#keys.keys()];
  }

  seal(purpose: SealPurpose, recordId: string, plaintext: string): SealedJson {
    const keyId = this.currentKeyId;
    const key = this.#keys.get(keyId) as Buffer;
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    cipher.setAAD(additionalData(purpose, recordId, keyId));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      keyId,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    };
  }

  /** Opens a sealed value. Fails closed, naming the key ID and never the value. */
  open(purpose: SealPurpose, recordId: string, sealed: SealedJson): string {
    const keyId = typeof sealed?.keyId === "string" ? sealed.keyId : "unknown";
    const key = this.#keys.get(keyId);
    if (!key)
      throw new ServiceError(
        503,
        "credential-unavailable",
        `Sealing key ${JSON.stringify(keyId)} is not available`,
      );
    let nonce: Buffer, tag: Buffer, ciphertext: Buffer;
    try {
      nonce = decode(sealed.nonce, 12);
      tag = decode(sealed.tag, 16);
      ciphertext = decode(sealed.ciphertext);
    } catch {
      throw new ServiceError(
        503,
        "credential-unavailable",
        `Sealed value under key ${JSON.stringify(keyId)} is malformed`,
      );
    }
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    decipher.setAAD(additionalData(purpose, recordId, keyId));
    decipher.setAuthTag(tag);
    const partial = decipher.update(ciphertext);
    try {
      return Buffer.concat([partial, decipher.final()]).toString("utf8");
    } catch {
      partial.fill(0);
      throw new ServiceError(
        503,
        "credential-unavailable",
        `Sealed value did not authenticate under key ${JSON.stringify(keyId)}`,
      );
    }
  }
}
