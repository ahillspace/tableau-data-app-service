# Shared contracts

These types and rules are shared across components.
The architecture owns them.
They are shown as TypeScript, condensed from the source; the code is authoritative.

## Identity and principal

```ts
type Identity = {
  deploymentId: string;   // bootstrap deployment ID
  siteId: string;         // Tableau site ID
  userId: string;         // Tableau user ID
};

// Who is calling, resolved from a service bearer on every request.
type Principal = {
  sessionId: string;
  kind: "app" | "operator";
  identityId: string;
  identity: Identity;
  trustedSiteId: string;  // the trusted site record; definition audiences name these
  siteContentUrl: string;
  userName: string;
  appId: string | null;   // null for operator bearers
  attribution: { siteContentUrl?: string; workbook?: string; view?: string };
  location: { verified: boolean };
  expiresAt: Date;        // last verified Tableau sign-in + sign-in limit
};
```

Two identities are equal only when all three fields are equal.
An identity is written as `deploymentId:siteId:userId` where a route or command names one.

## Service bearer

Every authenticated service request carries `Tableau-Service-Authorization: Bearer <token>`.
The service never reads its bearer from `Authorization`, so the native `Authorization` header stays the app's and the provider's.
Bearers are random 256-bit values; Postgres stores their SHA-256 hash.
App bearers and operator bearers use the same header and are told apart by the `kind` of their session record.

## Connection definition

```ts
type Ownership = "shared" | "personal";

type Placement =
  | { kind: "bearer" }
  | { kind: "header"; name: string; prefix?: string }
  | { kind: "query"; name: string };

type ConnectionDefinition = {
  id: string;
  displayName: string;
  type: string;                     // "oauth2", "static", "none" or a preset name
  ownership: Ownership;
  apiHosts: string[];
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  clientId?: string;
  tokenAuthentication?: "basic" | "post";
  scopes: string[];
  presetOptions: Record<string, unknown>;
  credentialPlacement: Placement;
  audience: string[];               // trusted site record IDs
  reauthorizationInterval?: number; // seconds
  privateHosts: boolean;
  enabled: boolean;
  retired: boolean;
  generation: number;
};

// What operators read: sealed values are never returned.
type DefinitionView = ConnectionDefinition & {
  clientSecretSet: boolean;
  signingSecretSet: boolean;
  secretsSetAt: Partial<Record<"clientSecret" | "signingSecret", string>>;
};
```

## Credential lease

```ts
type OutgoingRequest = { target: string; headers: [string, string][] };

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
A service error on a native or capability route is marked with the response header `Tableau-Service-Error: 1`, so the SDK can tell a service error from a provider's own error.
The router removes every `Tableau-Service-*` header from provider responses, so only the service can set the marker.
The SDK restores and resends a request only after a marked `sign-in-required` error, which the service returns before any provider is called; it never resends after any other 401.

## Revision

`installation_revision` is one row holding a counter.
Any transaction that writes definitions, trusted sites or operators increments it.
Replicas use it to know when cached definitions are stale.

## Sealed value

```ts
type SealedJson = { keyId: string; nonce: string; ciphertext: string; tag: string }; // base64url
```

Sealing uses AES-256-GCM with a 12-byte nonce, a 16-byte tag and additional data of `[1, purpose, recordId, keyId]`.
Purposes are `client-secret`, `signing-secret` and `credential`.

## Job

```ts
type JobState = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "interrupted";

type Job = {
  id: string;
  handler: string;
  definitionId: string;
  owner: Identity;
  appId: string;
  submissionKey: string;
  state: JobState;
  attempt: number;
  progress?: unknown;
  externalTaskId?: string;
  cancelRequested: boolean;
  remoteEffectsUnknown: boolean;
  result?: { available: boolean; expiresAt: string };
  error?: ServiceErrorBody["error"];
  createdAt: string;      // ISO 8601
  startedAt?: string;
  finishedAt?: string;
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
  receivedAt: string;     // ISO 8601
};
```

## Provider type

A provider type is code; the built-in types and each preset implement this interface.

```ts
interface ProviderType {
  name: string;
  oauth: "required" | "optional" | "none";  // optional: no client ID means static credentials only
  staticCredential: boolean;
  credentialless: boolean;
  defaults?(input: Record<string, unknown>): Record<string, unknown>;
  validate?(definition: ConnectionDefinition): FieldError[];
  authorizationParameters?(definition: ConnectionDefinition): Record<string, string>;
  readTokenResponse?(response: { status: number; body: unknown },
    context: { definition: ConnectionDefinition; refresh: boolean; now: Date }): TokenReading;
  describeAccount?(lease: CredentialLease, context: PresetContext): Promise<{ id: string; name: string | null } | null>;
  revoke?(lease: CredentialLease, context: PresetContext): Promise<void>;
  capabilities?: Capability[];
  jobHandlers?: JobHandlerDefinition[];
  eventSource?: EventSource;
}

type TokenReading =
  | { kind: "ok"; credential: StoredCredential; account: Account | null; scopes: string[] }
  | { kind: "error"; error: string; definitive: boolean; rejectsGrant: boolean };

type PresetContext = { fetch: typeof fetch; signal: AbortSignal };
```

`definitive` means the provider clearly refused, so nothing changed on its side.
`rejectsGrant` means the grant itself is gone and the user must authorize again.

## Job handler

```ts
type JobHandlerDefinition = {
  name: string;                                        // unique across the installation
  retrySafe: boolean;                                  // an uncertain attempt may be replayed
  retries?: { attempts: number; backoffSeconds: number };
  limits?: { inputBytes?: number; resultBytes?: number; runtimeSeconds?: number };
  validateInput?(input: unknown): FieldError[];
  run(context: JobRunContext): Promise<JobStepResult>;
  cancel?(context: { externalTaskId: string; checkout(): Promise<CredentialLease>;
    fetch: typeof fetch; signal: AbortSignal }): Promise<void>;
};

type JobRunContext = {
  input: unknown;
  resume: unknown;                 // the callback body when an external task resumed the Job
  attempt: number;
  checkout(): Promise<CredentialLease>;
  fetch: typeof fetch;
  progress(value: unknown): Promise<void>;
  callback(): Promise<{ url: string; verifier: string }>;
  signal: AbortSignal;
};

type JobStepResult =
  | { kind: "succeeded"; result: unknown }
  | { kind: "failed"; code: string; message: string }
  | { kind: "wait"; externalTaskId: string; checkAt?: Date }
  | { kind: "cancelled"; remoteEffectsUnknown: boolean };
```

## Event source

```ts
type EventSource = {
  signingSecret: "required" | "optional";
  ingest(delivery: { headers: Record<string, string | string[] | undefined>; body: Buffer; now: Date },
    context: { definition: ConnectionDefinition; signingSecret: string | undefined }): {
    response: { status: number; contentType?: string; body?: string };  // what the provider receives
    events: { id: string; type: string; account: string; payload: unknown }[];
  };
};
```
