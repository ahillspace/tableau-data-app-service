import type { CredentialInput, Definition } from "../contracts/operator.ts";
import type { FieldError } from "../platform/errors.ts";

export type * from "../contracts/operator.ts";
export const SECRET_FIELDS = ["clientSecret", "signingSecret", "signingPrivateKey"] as const;
export type ConnectionDefinition = Definition & {
  retired: boolean;
  generation: number;
  version: number;
  secretGeneration: number;
};
export type StoredCredential = {
  input?: Exclude<CredentialInput, { kind: "import" }>;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  derivedKey?: string;
};
export type OutgoingRequest = { target: string; headers: [string, string][] };
export type CredentialLease = {
  definition: ConnectionDefinition;
  connectionId: string | null;
  apply(request: OutgoingRequest): void;
};
export type ProtocolFetch = typeof fetch;
export type { FieldError };
