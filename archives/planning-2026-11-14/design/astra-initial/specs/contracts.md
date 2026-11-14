# Shared domain contracts

Status: proposed contract vocabulary and TypeScript shapes, not implementation code.
The architecture owner owns this file and resolves changes affecting more than one module.
Names describe domain values; branded IDs, runtime schemas and serialization helpers will be selected during implementation.
All IDs are opaque strings with bounded wire lengths.
Times on the wire are UTC RFC 3339 strings, and expiry comparisons use the server clock with a configured safety margin.

## Authority and configuration

```ts
type ExecutionIdentity = "none" | "service" | "delegated";
type CapabilityRef = { id: string; version: number };

type VerifiedAccess = {
  appId: string;
  bindingId: string;
  holderKey?: string;
  expiresAt: string;
  authorityRevision: string;
};

type AppRegistration = {
  appId: string;
  revision: number;
  enabled: boolean;
  allowedOrigins: readonly string[];
  capabilities: readonly {
    capability: CapabilityRef;
    providerRegistrationId?: string;
    serviceConnectionId?: string;
  }[];
};

type ConnectionOwner =
  | { kind: "service" }
  | { kind: "delegated"; appId: string; holderKey: string };

type ConnectionUse = {
  connectionId: string;
  authorizationEpoch: number;
  providerRegistrationId: string;
  owner: ConnectionOwner;
};
```

Only the trusted boundary produces `VerifiedAccess`; the public wire schema does not accept it as request data.
`bindingId` identifies one verified request/session authority for audit, while `holderKey` identifies the continuity boundary for delegated ownership.
The access adapter validates authority revision, expiry and revocation on each request and supports revalidation before dispatch.
App policy is loaded from current operator configuration, never from token claims alone.
The app registration does not contain a browser secret.
A service connection belongs to the internal administrative boundary and may be explicitly selected by several app configurations.
Each use is authorized against the requesting app's exact binding and attributed to that app; knowledge of the shared connection ID grants nothing.
Delegated connections remain owned by one app and holder association.

## Capability definition

```ts
type RetryPolicy =
  | { kind: "never" }
  | { kind: "safe-read"; maxAttempts: number }
  | { kind: "provider-key"; maxAttempts: number; validForSeconds: number };

type CapabilityDefinition = {
  ref: CapabilityRef;
  providerId?: string;
  title: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  identity: ExecutionIdentity;
  requiredPermissions: readonly string[];
  permissionCheck: "before-dispatch" | "provider-enforced";
  effect: "read" | "write";
  retry: RetryPolicy;
  limits: {
    deadlineMs: number;
    maxRequestBytes: number;
    maxResponseBytes: number;
    maxProviderRequests: number;
  };
  pagination?: { maxPageSize: number; cursorTtlSeconds: number };
  eventTypes: readonly string[];
};

type Page<T> = { items: readonly T[]; nextCursor?: string };
```

`JsonSchema` means a self-contained JSON Schema document in the implementation's selected supported dialect, with no network references or executable validation hooks.
The same source of truth provides runtime validation and exported TypeScript types; parallel hand-maintained schemas are not allowed.
Selecting the schema library and supported dialect is an implementation decision, not a missing authority rule.
Schemas bound every collection and untrusted string used by the capability.
Discovery returns these public definitions plus availability information, never provider endpoints, credential material, or external subject identifiers.
Unavailable delegated authorization is reported as `connection-required`; missing holder proof is `holder-required`.
A discovered capability is still reauthorized at invocation time.

Provider permission labels are adapter-defined and are not interpreted as universal OAuth scopes by the core.
With `before-dispatch`, the adapter must establish that the connection satisfies them from granted scopes or another documented provider authorization signal; absent evidence blocks execution.
With `provider-enforced`, the provider's authenticated operation is the authoritative permission check when reliable preflight evidence is unavailable, as with some API keys.
Known missing permission still blocks execution, and the adapter maps provider denial to a safe permission error without weakening the app or connection authority check.
Registration documents this distinction rather than assuming that every provider exposes introspectable scopes.
Identity, schema, effect, pagination semantics and required authority are immutable for a published capability version.
Breaking changes publish a new integer version, which an operator enables explicitly.

## Commands and results

```ts
type InvokeCommand = {
  capability: CapabilityRef;
  requestKey: string;
  input: unknown;
  connectionId?: string;
};

type EffectEvidence = "none" | "applied" | "partial" | "unknown";

type ServiceError = {
  code: string;
  message: string;
  effect: EffectEvidence;
  recovery:
    | { kind: "none" }
    | { kind: "retry"; afterMs?: number }
    | { kind: "connect"; providerRegistrationId: string }
    | { kind: "reauthorize"; connectionId: string }
    | { kind: "inspect"; invocationId: string }
    | { kind: "resync" };
};

type InvocationResult<O> =
  | { kind: "completed"; invocationId: string; output: O }
  | { kind: "failed"; invocationId?: string; error: ServiceError }
  | { kind: "pending"; invocationId: string; retryAfterMs: number }
  | { kind: "uncertain"; invocationId: string; error: ServiceError };

type InvocationReceipt = {
  invocationId: string;
  capability: CapabilityRef;
  state: "admitted" | "running" | "completed" | "failed" | "uncertain";
  effect: EffectEvidence;
  resultAvailableUntil?: string;
};
```

`requestKey` is caller-generated high-entropy command identity, not authority or a provider idempotency key.
The execution owner derives and stores any provider idempotency key from the durable invocation identity.
Equal command identity with a different canonical command digest is a conflict, never a second operation.
Recovery advice is actionable service policy; a raw provider HTTP status or exception cannot grant permission to retry a write.
`pending` means an already admitted inline request is still supervised, not that a job was queued.
`uncertain` means the service cannot establish the complete external effect.
A known partial effect is a failed result with `effect: partial`, unless the overall outcome itself remains uncertain.
Failure with `effect: applied` includes a provider success followed by output-validation failure.
None of these states is automatically converted into a fresh write.

## Owner interfaces

```ts
interface AccessBoundary {
  verify(evidence: unknown): Promise<VerifiedAccess>;
  revalidate(access: VerifiedAccess): Promise<void>;
}

interface CapabilityService {
  discover(access: VerifiedAccess): Promise<readonly unknown[]>;
  invoke(access: VerifiedAccess, command: InvokeCommand,
         signal: AbortSignal): Promise<InvocationResult<unknown>>;
  inspect(access: VerifiedAccess, invocationId: string): Promise<InvocationResult<unknown>>;
}

interface ConnectionService {
  begin(access: VerifiedAccess, request: AuthorizationRequest): Promise<AuthorizationView>;
  inspectAuthorization(access: VerifiedAccess, id: string): Promise<AuthorizationView>;
  disconnect(access: VerifiedAccess, connectionId: string): Promise<DisconnectResult>;
}

interface CapabilityContext {
  invocationId: string;
  signal: AbortSignal;
  deadline: string;
  request(request: ProviderRequest): Promise<ProviderResponse>;
}
```

`AuthorizationRequest`, `AuthorizationView` and `DisconnectResult` are defined in [access-connections.md](access-connections.md).
`ProviderRequest` and `ProviderResponse` are defined in [providers-execution.md](providers-execution.md).
These signatures deliberately exclude a raw database, arbitrary network client, secret getter, HTTP request, or mutable global session.
The registration layer binds the capability handler to its approved provider registration and connection before giving it a `CapabilityContext`.
Trusted provider authorization hooks receive credential material only in their narrower privileged lifecycle context.

## Stable failure categories

| Category | Meaning | Typical recovery |
| --- | --- | --- |
| `access-required`, `access-expired`, `access-denied` | Missing, expired or insufficient backend authority. | Renew the selected front-door binding; no provider login substitution. |
| `not-found` | Unknown or non-visible connection, capability, receipt or authorization transaction. | None; avoid revealing another holder's resources. |
| `invalid-input`, `request-conflict`, `unsupported` | Contract violation, reused key with changed command, or unsupported lifecycle. | Correct the request or module/configuration. |
| `holder-required`, `connection-required`, `reauthorization-required` | Missing delegated binding or provider authorization. | Obtain the required binding or explicit connection flow. |
| `permission-required` | Connection lacks proven provider permissions. | Explicit reauthorization if supported. |
| `busy`, `rate-limited`, `provider-unavailable` | Bounded local or remote capacity failure. | Retry only when effect evidence and policy permit. |
| `cancelled`, `deadline-exceeded` | Work stopped or exceeded its budget. | Inspect any admitted write before deciding on a new command. |
| `outcome-unknown`, `partial-effect`, `invalid-provider-output` | External effect cannot be represented as normal success. | Inspect or provider-specific reconciliation. |
| `cursor-expired`, `resync-required`, `result-expired` | Required retained state is unavailable. | Reread current state; do not silently repeat a write. |
| `internal-error`, `storage-unavailable` | Service cannot uphold its contract. | Safe bounded retry only where no uncertain effect exists. |

Error messages and details are service-controlled safe metadata.
Provider bodies, credential fields, callback query strings, and external account identities do not flow into this common error shape.
