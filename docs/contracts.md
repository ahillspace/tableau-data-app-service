# Shared contracts

These types and rules are shared across components.
The architecture owns them.
The types specify the current shared contract; implementation verification is recorded separately in [verification](verification.md).

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

App and CLI requests carry `Tableau-Service-Authorization: Bearer <token>`.
The optional same-origin console uses an operator cookie on the same admin API, with the checks in [console](console.md).
The service never reads its bearer from `Authorization`, so the native `Authorization` header stays the app's and the provider's.
Bearers are random 256-bit values; Postgres stores their SHA-256 hash.
App bearers and operator bearers use the same header and are told apart by the `kind` of their session record.

## Connection definition

```ts
type Method = "authorization_code" | "client_credentials" | "jwt_bearer"
  | "signed_jwt_direct" | "static" | "none";
type Placement = { kind: "bearer" }
  | { kind: "header"; name: string; prefix?: string }
  | { kind: "query"; name: string }
  | { kind: "basic" };
type SecretField = "clientSecret" | "signingSecret" | "signingPrivateKey";
type SecretMeta = { set: boolean; setAt: string | null };
type Definition = {
  id: string; displayName: string; ownership: "shared" | "personal";
  apiHosts: string[]; credentialPlacement: Placement;
  authentication: Authentication;
  audience: string[]; scopes: string[]; reauthorizationInterval?: number;
  privateHosts: boolean; enabled: boolean;
  accountLookup?: AccountLookup; revocation?: ProtocolRequest;
  webhook?: Webhook;
  credentialImport?: CredentialImport;
};
type DefinitionView = Definition & {
  retired: boolean; generation: number; version: number;
  secrets: Record<SecretField, SecretMeta>;
  credential: SecretMeta;
  connectionCounts: { connected: number; needsAuthorization: number; disconnected: number };
  setup: { state: "ready" | "needs-setup" | "disabled" | "retired";
    missing: string[]; actions: ("connect" | "set-credential" | "set-secrets")[] };
};
type DefinitionWrite = Definition & {
  secrets?: Partial<Record<SecretField, string | null>>;
  credential?: CredentialInput | null;
};
```

Dates are ISO 8601 UTC strings and numeric generations/versions are positive integers.
`version` changes on each definition or secret mutation; `generation` changes only when the credential destination or interpretation changes.
`credential` metadata refers only to a shared connection; personal credentials are never exposed in an operator definition view.
For a personal or credentialless definition its safe credential metadata is `{set:false,setAt:null}`.
Connection records expose their own `credentialGeneration` and credential metadata without returning sealed or open values.
Missing setup prerequisites are a usable configuration state, shown as “Needs setup”; checkout fails closed with a stable error.
Name, audience, scopes, enabled state, reauthorization interval and secret values change in place.
All other definition changes require PUT redefinition, including hosts, ownership, acquisition/client authentication, placement, import mappings, lookup, revocation and webhook protocol configuration.
Redefinition atomically increments generation, disconnects existing connections, deletes their credentials and invalidates in-progress setup.
Secret rotation never redefines a provider or changes its ID.
Retirement is irreversible for that ID and ends all connection authority.

Safe setup metadata is described in [connections](connections.md#setup-readiness).
Authentication, lookup, revoke, import and webhook types are specified in [provider protocol data](provider-protocol.md).
Shared browser-safe data types are exported from `src/contracts/operator.ts`; consumers use type-only imports.

## Credential lease

```ts
type OutgoingRequest = { target: string; headers: [string, string][] };

type CredentialLease = {
  definition: DefinitionView;
  connectionId: string | null;      // null for method "none"
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
Purposes distinguish client secrets, webhook verification secrets, application signing keys and connection credentials.
A connection credential is bound to its connection record, while application secrets are bound to their definition and field.

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

## Credential protocol owner

The connections owner interprets [typed protocol data](provider-protocol.md) through one acquisition/client-authentication/placement pipeline.
A catalog template contains data, with no executable authentication, lookup, revocation or verification hook.
Capability and Job implementations remain explicit code extension points with shared checkout and outbound transport.
A token response distinguishes usable credentials, definitive refusal, rejected grant and uncertain exchange.
Only rejected grants require a new authorization; uncertain outcomes never become claimed provider refusal.

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

## Event verification

The configured Webhook union is in [provider protocol data](provider-protocol.md#webhook-schema).
The Events owner receives original bytes and returns a protocol response plus zero or more verified, sanitized events.
A handshake returns zero events.
Verification secrets and raw verification-only fields are never present in a ServiceEvent or diagnostic.
