import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** A random 256-bit value, base64url encoded. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The SHA-256 of a value, hex encoded. Stored in place of bearer-like values. */
export function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The S256 PKCE challenge of a verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
