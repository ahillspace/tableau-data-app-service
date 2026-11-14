import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

const envelopeSchema = z.strictObject({
  v: z.literal(1),
  keyId: z.string().min(1).max(100),
  nonce: z.string(),
  ciphertext: z.string(),
  tag: z.string(),
});
export type EncryptedEnvelope = z.infer<typeof envelopeSchema>;
export type SecretBinding = Readonly<{
  kind: string;
  id: string;
  provider?: string;
  revision: string;
}>;
function context(binding: SecretBinding, keyId: string): Buffer {
  return Buffer.from(
    JSON.stringify([
      1,
      keyId,
      binding.kind,
      binding.id,
      binding.provider ?? null,
      binding.revision,
    ]),
  );
}
function decode(value: string): Buffer {
  const result = Buffer.from(value, "base64url");
  if (result.toString("base64url") !== value) throw new Error("Invalid encrypted envelope");
  return result;
}
export class SecretBox {
  readonly #keys: ReadonlyMap<string, Buffer>;
  constructor(
    readonly activeKeyId: string,
    keys: ReadonlyMap<string, Buffer>,
  ) {
    if (!keys.has(activeKeyId) || [...keys.values()].some((key) => key.length !== 32))
      throw new Error("Invalid encryption keys");
    this.#keys = new Map([...keys].map(([id, key]) => [id, Buffer.from(key)]));
    const binding = { kind: "probe", id: "startup", revision: "1" };
    if (this.open(this.seal(Buffer.from("probe"), binding), binding).toString() !== "probe")
      throw new Error("Encryption probe failed");
  }
  seal(plaintext: Uint8Array, binding: SecretBinding, keyId = this.activeKeyId): EncryptedEnvelope {
    const key = this.#keys.get(keyId);
    if (!key) throw new Error("Unknown encryption key");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    cipher.setAAD(context(binding, keyId));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      v: 1,
      keyId,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    };
  }
  open(value: unknown, binding: SecretBinding): Buffer {
    const envelope = envelopeSchema.parse(value);
    const key = this.#keys.get(envelope.keyId);
    if (!key) throw new Error("Unknown encryption key");
    const nonce = decode(envelope.nonce),
      tag = decode(envelope.tag),
      ciphertext = decode(envelope.ciphertext);
    if (nonce.length !== 12 || tag.length !== 16) throw new Error("Invalid encrypted envelope");
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    decipher.setAAD(context(binding, envelope.keyId));
    decipher.setAuthTag(tag);
    const unpublished = decipher.update(ciphertext);
    try {
      return Buffer.concat([unpublished, decipher.final()]);
    } catch {
      unpublished.fill(0);
      throw new Error("Encrypted record authentication failed");
    }
  }
}
