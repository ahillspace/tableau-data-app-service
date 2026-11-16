# Shared contracts

These types and rules are shared across components.
The architecture owns them; a component proposes a change here before depending on it.
Types are illustrative TypeScript; the code is authoritative once written.

## Identity

```ts
type Identity = {
  deploymentId: string;   // bootstrap deployment ID
  siteId: string;         // Tableau site ID
  userId: string;         // Tableau user ID
};

type AppSession = {
  id: string;
  identity: Identity;
  appId: string;
  attribution: { siteContentUrl?: string; workbook?: string; view?: string };
  location: { verified: boolean };
  expiresAt: Date;        // last verified Tableau sign-in + sign-in limit
};
```

Two identities are equal only when all three fields are equal.

## Service bearer

Every authenticated service request carries `Tableau-Service-Authorization: Bearer <token>`.
The service never reads its bearer from `Authorization`, so the native `Authorization` header stays the app's and the provider's.
Bearers are random 256-bit values; Postgres stores their SHA-256 hash.
Operator bearers and app bearers use the same header and are told apart by their session record.

## Connection definition

```ts
type Ownership = "shared" | "personal";

type ConnectionDefinition = {
  id: string;
  displayName: string;
  type: "oauth2" | "static" | "none" | PresetName;
  ownership: Ownership;
  apiHosts: string[];
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  clientId?: string;
  clientSecretSet: boolean;
  scopes: string[];
  presetOptions: Record<string, unknown>;
  credentialPlacement: { kind: "bearer" } | { kind: "header"; name: string; prefix?: string } | { kind: "query"; name: string };
  audience: string[];               // trusted site IDs
  reauthorizationInterval?: number; // seconds
  privateHosts: boolean;
  enabled: boolean;
  retired: boolean;
  generation: number;
};
```

## Credential lease

```ts
type CredentialLease = {
  definition: ConnectionDefinition;
  connectionId: string | null;      // null for type "none"
  apply(request: OutgoingRequest): void;
};
```

A lease lives for one request or one Job step and is never stored or serialized.

## Errors

Every service error has one JSON shape:

```ts
type ServiceErrorBody = {
  error: {
    code: string;            // stable, kebab-case
    message: string;         // human-readable, never contains a secret
    fields?: { path: string; rule: string }[];   // validation failures
    upstream?: "not-sent" | "may-have-been-sent";
  };
};
```

Native provider responses are never wrapped in this shape.
A service error on a native route is marked with the response header `Tableau-Service-Error: 1`, so the SDK can tell a service error from a provider's own error.

## Revision

`installation_revision` is one row holding a counter.
Any transaction that writes definitions, trusted sites or operators increments it.
Replicas use it to know when cached data is stale.

## Sealed value

```ts
type Sealed = { keyId: string; nonce: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array };
```

Sealing uses AES-256-GCM with additional data of `purpose`, `recordId` and `keyId`.
Purposes are `client-secret`, `signing-secret`, `credential`.

## Job

```ts
type JobState = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "interrupted";

type Job = {
  id: string;
  handler: string;
  owner: Identity;
  appId: string;
  submissionKey: string;
  state: JobState;
  progress?: unknown;
  result?: { available: boolean; expiresAt: Date };
  error?: ServiceErrorBody["error"];
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
};
```

## Event

```ts
type ServiceEvent = {
  id: string;
  definitionId: string;
  type: string;
  account: string;
  payload: unknown;
  receivedAt: Date;
};
```

## Preset interface

```ts
interface Preset {
  name: string;
  defaults(options: Record<string, unknown>): Partial<ConnectionDefinition>;
  validate(definition: ConnectionDefinition): FieldError[];
  readTokenResponse?(body: unknown, options: Record<string, unknown>): StoredCredential;
  describeAccount?(lease: CredentialLease): Promise<{ account: string } | null>;
  revoke?(lease: CredentialLease): Promise<void>;
  capabilities?: Capability[];
  jobHandlers?: JobHandler[];
  eventSource?: EventSource;
}
```
