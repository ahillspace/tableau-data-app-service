# Shared contracts

Status: proposal, revision R1 for the first drafting round.
Only the architecture orchestrator edits this file.
Pseudotypes define behavior, not a compiled package or an implemented API.

## Names and trust

An AppId identifies operator-managed app configuration within one internal administrative boundary.
A BindingId is an opaque, server-verified execution principal scoped to exactly one app, without requiring a local human account.
It is not a connection ID, browser-selected viewer name, Tableau session cookie, app URL, or external account ID.
The future front door must establish binding possession, app association, expiry, revocation, replay protection and safe browser transport before these APIs can accept real callers.
Delegated connection persistence requires a stable binding or an explicit trusted rebinding mechanism; this mechanism is deliberately unresolved.
No module may synthesize a trusted context from request body identifiers.

```ts
type Id = string; // opaque server-generated identifier unless operator-configured
type TrustedContext = {
  appId: Id; bindingId: Id; requestId: Id;
  authorityExpiresAt: string; // ISO UTC; checked at admission and dispatch
}; // constructed only by a trusted adapter; never deserialized from client JSON
type IdentityMode = 'none' | 'app' | 'delegated';
type Effect = 'read' | 'write';
type CapabilityRef = { id: string; version: number };
type AppRegistration = {
  id: Id; enabled: boolean; revision: number; allowedOrigins: string[];
  capabilities: Array<{
    capability: CapabilityRef;
    identity: IdentityMode;
    appConnectionId?: Id; // mandatory only for app identity
  }>;
};
type ConnectionOwner =
  | { kind: 'app'; appId: Id }
  | { kind: 'delegated'; appId: Id; bindingId: Id };
type ConnectionState = 'authorizing' | 'ready' | 'reauthorization_required'
  | 'disabled' | 'disconnected';
type SafeConnection = {
  id: Id; providerId: string; state: ConnectionState; identity: 'app' | 'delegated';
  revision: number; authorizationExpiresAt?: string;
}; // no external account IDs or credentials
type ExecutionState = 'accepted' | 'running' | 'succeeded' | 'failed'
  | 'cancelled' | 'outcome_unknown';
type ErrorCode = 'INVALID_INPUT' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND'
  | 'CONNECTION_REQUIRED' | 'REAUTHORIZATION_REQUIRED' | 'UNSUPPORTED'
  | 'CONFLICT' | 'RATE_LIMITED' | 'PROVIDER_UNAVAILABLE' | 'DEADLINE_EXCEEDED'
  | 'CANCELLED' | 'OUTCOME_UNKNOWN' | 'CURSOR_EXPIRED' | 'RESYNC_REQUIRED'
  | 'INTERNAL';
type Problem = {
  code: ErrorCode; message: string; requestId: Id;
  retry: 'never' | 'safe' | 'after_reauthorization' | 'inspect_execution';
  retryAfterMs?: number; executionId?: Id;
}; // allowlisted message; no raw provider error body, URL or stack
type Result<T> = { ok: true; data: T; requestId: Id }
  | { ok: false; error: Problem };
type ExecutionRequest = {
  capability: CapabilityRef; input: unknown;
  connectionId?: Id; // delegated selection only; no authority conveyed
  idempotencyKey: string; // required for all execution admissions
};
type ExecutionView<T = unknown> = {
  id: Id; capability: CapabilityRef; state: ExecutionState;
  result?: T; error?: Problem; createdAt: string; updatedAt: string;
};
type Page<T> = { items: T[]; nextCursor?: string };
```

## Capability and provider entrypoints

Each capability has a namespaced ID, immutable major contract version, runtime input/output schemas, identity mode, required provider authorization, effect, maximum duration, input/output size limits and pagination declaration.
Each descriptor fixes one identity mode; distinct modes require distinct capability entries so callers cannot silently change execution identity.
Provider authorization is a provider-owned structured requirement, evaluated by that provider against server-stored granted authorization, rather than a universal OAuth scope string.
Registry construction rejects missing schemas, unknown providers, duplicate capability versions and unsupported credential strategies.
Schema validation happens at both invocation and result boundaries.

```ts
type CapabilityDefinition<I, O> = {
  ref: CapabilityRef; providerId: string; identity: IdentityMode; effect: Effect;
  inputSchema: object; outputSchema: object;
  authorization: object; maxDurationMs: number; maxInputBytes: number; maxOutputBytes: number;
  pagination: 'none' | 'cursor';
  retry: 'read_safe' | 'provider_idempotent' | 'never';
  execute(input: I, context: CapabilityContext): Promise<O>;
};
type CapabilityContext = {
  executionId: Id; signal: AbortSignal; deadlineAt: string;
  provider: AuthorizedProviderClient; // opaque brokered client, never raw secrets
};
```

The AuthorizedProviderClient is issued for one execution, connection revision and capability policy, and expires with that execution.
For identity none, it permits only declared unauthenticated operations.
Provider modules own protocol-specific authorize/exchange/refresh/derive/revoke/verify-event behavior and safe response mapping.
The connection service owns encrypted persistence and credential concurrency; the execution service owns admission, retries, dispatch and effect uncertainty.
The provider transport must check connection revocation and execution fencing immediately before outbound dispatch.
Credential leases do not promise to recall a request already accepted by an external provider.
Provider endpoints and redirect URIs come from operator-reviewed configuration; caller input cannot select arbitrary network destinations.

## Cross-module calls

```ts
discover(ctx: TrustedContext): Promise<Result<CapabilityDescriptor[]>>;
authorizeExecution(ctx: TrustedContext, request: ExecutionRequest): Promise<Result<ExecutionGrant>>;
beginAuthorization(ctx: TrustedContext, providerId: string): Promise<Result<AuthorizationStart>>;
readConnection(ctx: TrustedContext, connectionId: Id): Promise<Result<SafeConnection>>;
disconnect(ctx: TrustedContext, connectionId: Id): Promise<Result<SafeConnection>>;
acquireProviderClient(grant: ExecutionGrant, signal: AbortSignal): Promise<Result<AuthorizedProviderClient>>;
submit(ctx: TrustedContext, request: ExecutionRequest): Promise<Result<ExecutionView>>;
readExecution(ctx: TrustedContext, executionId: Id): Promise<Result<ExecutionView>>;
cancelExecution(ctx: TrustedContext, executionId: Id): Promise<Result<ExecutionView>>;
```

ExecutionGrant is a server-only, nonserializable decision binding app, binding, capability version, app revision, optional connection ID/revision, identity and authorization requirements.
Policy is evaluated again immediately before dispatch against current app and connection state.
App connections are selected exclusively by app registration; submitting connectionId for none or app identity is INVALID_INPUT.
An inaccessible connection or execution returns NOT_FOUND to avoid exposing its existence.
A valid caller with an enabled delegated capability and no connection receives CONNECTION_REQUIRED.
Missing proof receives UNAUTHENTICATED even for a capability needing no external credentials.

## Invariants

- One app configuration belongs to the team, not a customer tenant.
- Credentials never cross the HTTP/SDK boundary or capability result boundary.
- Delegated access requires equality of both app and binding owner.
- App credential use requires current explicit capability-to-connection configuration.
- External provider subjects are credential metadata, not local accounts or proof of caller identity.
- Authorization failure cannot substitute a different execution identity.
- A write whose dispatch may have happened cannot be reported as safely failed or blindly retried.
- A callback, webhook, event cursor or idempotency key is not independent authority to read a resource.

## Deferred boundary

This contract intentionally cannot authenticate a production Data App until the front-door trust mechanism is selected and verified.
Operator fixtures may construct trusted contexts in future contract tests, but cannot be offered as a browser authentication design.
Tableau Cloud/Server and embedding compatibility are an environment capability gate to verify before implementation; the core does not promise parity.
