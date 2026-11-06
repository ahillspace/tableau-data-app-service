# Shared contracts

Status: proposal, revision R3 integrated after adversarial and scenario agent review; not user accepted or implemented.
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
  authorityEpoch: string; // deployment recovery generation, outside DB restore boundary
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
  eventSubscriptions: EventSubscription[];
};
type ConnectionOwner =
  | { kind: 'app'; appId: Id }
  | { kind: 'delegated'; appId: Id; bindingId: Id };
type ConnectionState = 'authorizing' | 'ready' | 'reauthorization_required'
  | 'disabled' | 'disconnected';
type SafeConnection = {
  id: Id; providerId: string; state: ConnectionState; identity: 'app' | 'delegated';
  revision: number; authorizationExpiresAt?: string;
  display?: { label: string }; // optional reviewed provider-mapped account label
  remoteRevocation?: 'pending' | 'confirmed' | 'unconfirmed' | 'unsupported';
}; // no raw external subject IDs, credentials or unreviewed identity claims
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
  page?: { cursor?: string; pageSize?: number };
};
type ExecutionView<T = unknown> = {
  id: Id; capability: CapabilityRef; state: ExecutionState;
  result?: T; error?: Problem; createdAt: string; updatedAt: string;
  cancelRequestedAt?: string;
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
type PaginationDeclaration =
  | { pagination: 'none'; pageLimits?: never }
  | { pagination: 'cursor'; pageLimits: { defaultSize: number; maxSize: number } };
type CapabilityDefinition<I, O> = {
  ref: CapabilityRef; providerId: string; identity: IdentityMode; effect: Effect;
  inputSchema: object; outputSchema: object;
  authorization: object; maxDurationMs: number; maxInputBytes: number; maxOutputBytes: number;
  operations: readonly string[];
  retry: 'read_safe' | 'provider_idempotent' | 'never';
  execute(input: I, context: CapabilityContext): Promise<CapabilityOutput<O>>;
} & PaginationDeclaration;
type CapabilityContext = {
  executionId: Id; signal: AbortSignal; deadlineAt: string;
  provider: AuthorizedProviderClient; // opaque brokered client, never raw secrets
  page?: { size: number; cursor?: ProviderCursor }; // server-only resolved cursor
};
type AuthorizedProviderClient = {
  call(operation: string, parameters: unknown): Promise<ProviderOperationResult>;
};
type ProviderOperationResult = { data: unknown; nextCursor?: ProviderCursor };
type ProviderFailure = {
  problem: Problem;
  certainty: 'not_sent' | 'definitive_no_effect' | 'may_have_effect' | 'confirmed_effect';
}; // internal classified failure; external messages are never copied
type ProviderCursor = unknown; // provider-owned server-only pagination value
type CapabilityOutput<O> = { value: O; continuation?: ProviderCursor };
```

For paginated reads the handler returns `value: {items: [...]}` and an optional server-only continuation.
The executor stores the continuation in its cursor repository, inserts only the opaque client handle as nextCursor, then validates the complete Page against the published output schema.
Non-paginated handlers must not return a continuation; no handler may put native pagination state directly in its public value.

The AuthorizedProviderClient is issued for one execution, connection revision and capability policy, and expires with that execution.
For identity none, it permits only declared unauthenticated operations.
Provider modules own protocol-specific authorize/exchange/refresh/derive/revoke/verify-event behavior and safe response mapping.
The connection service owns encrypted persistence and credential concurrency; the execution service owns admission, retries, dispatch and effect uncertainty.
The provider transport checks current policy and fences before committing dispatch intent, then checks them again before the network send.
The durable intent is the authorization boundary for in-flight work; the final check cannot be atomic with a provider network send.
Disconnect committed before intent prevents dispatch admission; disconnect after intent cannot promise no later wire send.
Credential leases do not promise to recall a request already accepted by an external provider.
Provider endpoints and redirect URIs come from operator-reviewed configuration; caller input cannot select arbitrary network destinations.

## Cross-module calls

```ts
discover(ctx: TrustedContext): Promise<Result<CapabilityDescriptor[]>>;
authorizeExecution(ctx: TrustedContext, request: ExecutionRequest): Promise<Result<ExecutionGrant>>;
beginAuthorization(ctx: TrustedContext, request: {
  providerId: string; connectionId?: Id;
}): Promise<Result<AuthorizationStart>>;
readAuthorizationAttempt(ctx: TrustedContext, attemptId: Id): Promise<Result<AuthorizationAttemptView>>;
cancelAuthorization(ctx: TrustedContext, attemptId: Id): Promise<Result<AuthorizationAttemptView>>;
listConnections(ctx: TrustedContext, page?: { cursor?: string }): Promise<Result<Page<SafeConnection>>>;
readConnection(ctx: TrustedContext, connectionId: Id): Promise<Result<SafeConnection>>;
disconnect(ctx: TrustedContext, connectionId: Id): Promise<Result<SafeConnection>>;
acquireProviderClient(grant: ExecutionGrant, signal: AbortSignal): Promise<Result<AuthorizedProviderClient>>;
submit(ctx: TrustedContext, request: ExecutionRequest): Promise<Result<ExecutionView>>;
readExecution(ctx: TrustedContext, executionId: Id): Promise<Result<ExecutionView>>;
cancelExecution(ctx: TrustedContext, executionId: Id): Promise<Result<ExecutionView>>;
listEvents(ctx: TrustedContext, request: { cursor: string; pageSize?: number }): Promise<Result<EventPage>>;
resyncEvents(ctx: TrustedContext): Promise<Result<{ baselineCursor: string }>>;
```

ExecutionGrant is a server-only, nonserializable decision binding app, binding, capability version, app revision, optional connection ID/revision, identity, authority epoch and authorization requirements.
Policy is evaluated again immediately before dispatch against current app and connection state.
App connections are selected exclusively by app registration; submitting connectionId for none or app identity is INVALID_INPUT.
An inaccessible connection or execution returns NOT_FOUND to avoid exposing its existence.
A valid caller with an enabled delegated capability and no connection receives CONNECTION_REQUIRED.
Missing proof receives UNAUTHENTICATED even for a capability needing no external credentials.
Browser connection list/read/disconnect methods expose only delegated connections owned by the exact app/binding; app-owned lifecycle operations are operator-only.
Connection listing uses bounded opaque cursors and never returns secret or raw subject data.

## Authorization and credential types

`SafeConnection.revision` is the single logical authorization revision used by grants, results and cursors.
It changes for grant replacement, permission changes, disable/enable, disconnect and recovery invalidation; connection owner and provider are immutable.
Internal `credentialVersion` changes when secret material rotates without changing the logical grant and does not invalidate a grant or old result by itself.
In-place reauthorization must verify the same provider subject and increments the logical revision; changing subjects creates a new connection ID and requires explicit caller selection.
The broker records the actual credentialVersion on each dispatch attempt for audit without exposing it to clients or pinning an execution to a rotating token.
Derived credential cache keys and validity checks include parent connection ID, logical revision, credentialVersion, authority epoch, audience, granted authorization and expiry.
The initial contract invalidates local derived use and re-derives after any parent credentialVersion change, even when logical revision stays the same.
This is a conservative local validity fence, not proof that the provider revoked an already-issued child credential.

```ts
type AuthorizationAttemptState = 'pending' | 'callback_received' | 'exchanging'
  | 'succeeded' | 'failed' | 'cancelled' | 'expired' | 'outcome_unknown';
type AuthorizationStart = { attemptId: Id; authorizationUrl: string; expiresAt: string };
type AuthorizationAttemptView = {
  id: Id; providerId: string; state: AuthorizationAttemptState;
  connection?: SafeConnection; expiresAt: string; updatedAt: string;
};
type SafeCallbackResult = { status: 'completed' | 'denied' | 'expired' | 'unconfirmed' };
type CredentialState = 'candidate' | 'current' | 'retired' | 'quarantined' | 'cleanup_only' | 'erased';
type RefreshPhase = 'prepared' | 'dispatched' | 'committed' | 'failed' | 'outcome_unknown';
type CredentialKind = 'bearer' | 'api_key' | 'derived';
type AuthorizationMethod = 'none' | 'oauth_code_pkce' | 'client_credentials' | 'operator_secret' | 'derived';
type RenewalPolicy = 'none' | 'refresh' | 'reacquire' | 'derive';
type CredentialCandidate = {
  material: SecretMaterial; kind: CredentialKind; granted: object;
  subject?: ServerOnlySubject;
  expiry: { kind: 'at'; at: string } | { kind: 'non_expiring' };
};
type CredentialProfile = {
  method: AuthorizationMethod; kind?: CredentialKind;
  identities: readonly IdentityMode[]; renewal: RenewalPolicy;
  refreshReplay: 'unsupported' | 'unsafe' | 'documented_safe';
  revocation: 'unsupported' | 'supported';
};
type AuthorizationAdapter = {
  profiles: readonly CredentialProfile[];
  satisfies(granted: object, required: object): boolean;
  begin?: (request: ProtocolBeginRequest) => Promise<AuthorizationRedirect>;
  exchange?: (request: ProtocolExchangeRequest) => Promise<CredentialCandidate>;
  acquire?: (request: ServiceGrantRequest) => Promise<CredentialCandidate>;
  refresh?: (request: RenewalRequest) => Promise<CredentialCandidate>;
  derive?: (request: DerivationRequest) => Promise<CredentialCandidate>;
  revoke?: (request: RevocationRequest) => Promise<'confirmed' | 'unconfirmed'>;
};
```

SecretMaterial and ServerOnlySubject are opaque internal values accessible only to credential protocol code and its secure transport.
ProtocolBeginRequest contains server-created state, PKCE challenge, exact redirect URI, the provider-owned authorization requirements of currently enabled delegated capabilities, and operator provider-configuration reference.
The adapter constructs the smallest documented request satisfying that reviewed requirement set within the configured authorization ceiling; if it cannot combine the requirements safely, begin returns UNSUPPORTED.
AuthorizationRedirect contains the reviewed authorization URL.
ProtocolExchangeRequest contains validated code, decrypted verifier, exact redirect URI, configuration reference, deadline and signal.
ServiceGrantRequest contains operator configuration, reviewed authorization requirements, deadline and signal.
RenewalRequest contains current secret material, granted authorization, configuration reference, deadline and signal.
DerivationRequest additionally contains parent connection/revision/credentialVersion, required audience, authorization and maximum lifetime.
RevocationRequest contains restricted cleanup material, configuration reference, deadline and signal.
These values never cross HTTP, SDK or capability-handler boundaries.
An absent hook means unsupported, not a fallback; registry validation requires every hook needed by each declared profile and rejects mismatches.
No expiry may be inferred from absence; the adapter must map documented provider behavior to an explicit candidate expiry.

Callback processing is a server protocol operation `handleProviderCallback(providerId, rawProtocolRequest): Promise<SafeCallbackResult>`.
The connection owner validates protocol correlation and atomically claims the attempt before exchange, then checks current app revision, binding validity, authority epoch and attempt fence before installation.
The future trusted adapter must support checking a stored binding's current validity and callback continuity without treating state as caller authentication.
Its revocation checks must compose with local authorization-attempt and dispatch fencing; a cached claim alone is not a current-validity check.
If that proof/check is unavailable, delegated authorization cannot activate; this is a front-door blocker, not permission to trust correlation alone.
Operator-only app credential provisioning, rotation, enable/disable and registration mutation use a separate OperatorContext; no browser endpoint accepts this context.

## Event types

```ts
type EventRef = { providerId: string; type: string; version: number };
type EventSubscription = {
  id: Id; revision: number; event: EventRef; connectionId: Id;
  audience: 'app' | 'connection_owner';
};
type EventDefinition = {
  ref: EventRef; dataSchema: object;
  resyncCapability: CapabilityRef; // current-state read, explicitly enabled by app policy
};
type EventEnvelope<T = unknown> = {
  eventId: Id; event: EventRef; receivedAt: string; occurredAt?: string; data: T;
};
type EventPage<T = unknown> = { items: EventEnvelope<T>[]; nextCursor: string };
type ProviderEventAdapter = {
  definitions: readonly EventDefinition[];
  maxRedeliveryAgeMs: number; // documented bound, or initial event support is unsupported
  verifyAndNormalize(request: RawEventRequest): Promise<VerifiedProviderEvent>;
};
```

RawEventRequest consists of bounded original bytes, relevant headers and fixed endpoint configuration.
VerifiedProviderEvent contains verified source event ID, EventRef, validated safe data and a server-resolved connection reference with its logical revision; it is never a browser payload.
Subscription audience app is valid only for an app-owned connection and explicitly permits current bindings of that app; connection_owner is valid only for a delegated connection and its exact binding owner.
The operator approves subscriptions; neither event payloads nor browser bodies nominate recipients.
Initial event delivery requires a configured connection and a current-state read capability; unauthenticated connectionless events and events without a usable resync read are unsupported until explicitly designed.
Subscription and event schema version, original connection revision, current capability policy and authority epoch constrain every delivery.

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
