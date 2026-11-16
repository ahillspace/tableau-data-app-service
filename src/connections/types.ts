import type { Placement } from "../persistence/schema.ts";
import type { FieldError } from "../platform/errors.ts";

export type { Placement };
export type Ownership = "shared" | "personal";
export type BuiltInType = "oauth2" | "static" | "none";

/** A connection definition as the operator API reads and writes it. Sealed values are never part of it. */
export type ConnectionDefinition = {
  id: string;
  displayName: string;
  type: string;
  ownership: Ownership;
  apiHosts: string[];
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  clientId?: string;
  /** How a client secret is sent to the token endpoint: HTTP Basic (the OAuth 2.0 default) or the form body. */
  tokenAuthentication?: "basic" | "post";
  scopes: string[];
  presetOptions: Record<string, unknown>;
  credentialPlacement: Placement;
  audience: string[];
  reauthorizationInterval?: number;
  privateHosts: boolean;
  enabled: boolean;
  retired: boolean;
  generation: number;
};

export type SecretField = "clientSecret" | "signingSecret";
export type LinkField = SecretField | "credential";

/** The operator view of a definition: the definition plus when each sealed secret was set. */
export type DefinitionView = ConnectionDefinition & {
  clientSecretSet: boolean;
  signingSecretSet: boolean;
  secretsSetAt: Partial<Record<SecretField, string>>;
};

/** What a connection's sealed credential holds once opened. */
export type StoredCredential = {
  accessToken: string;
  refreshToken?: string;
  /** ISO time the access token expires, when the provider said. */
  expiresAt?: string;
};

/**
 * A request the router or a preset is about to send. `target` is the raw request target (path and query)
 * exactly as it will be sent. A lease places its credential on it.
 */
export type OutgoingRequest = { target: string; headers: [string, string][] };

export type CredentialLease = {
  definition: ConnectionDefinition;
  /** Null for type `none`. */
  connectionId: string | null;
  apply(request: OutgoingRequest): void;
};

export type ProtocolFetch = typeof fetch;
export type { FieldError };
