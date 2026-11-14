import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}
export function verifier(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}
export function verifySecret(secret: string, expected: string): boolean {
  const actual = Buffer.from(verifier(secret), "hex");
  const stored = Buffer.from(expected, "hex");
  return stored.length === actual.length && timingSafeEqual(actual, stored);
}
