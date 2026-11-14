# Shared contracts

Status: integrated technical contracts for the accepted architecture, checked for owner consistency and viewer presentation.
Implementation proof remains pending; historical independent reviews apply to their earlier snapshots.
This document owns shared types and cross-component handoffs; component specifications own their state transitions and enforcement.
Illustrative TypeScript describes interfaces, not implemented code or a published wire compatibility promise.
Use one maintained runtime-schema/type source at implementation time, bounded opaque IDs and database time for persisted expiry.

## Caller, app, and connection authority

```ts
type VerifiedIdentity = Readonly<{
  deploymentId: string;
  siteId: string;
  subjectId: string;
  verifiedAt: string;
  adapterId: string;
}>;
type AccessContext = Readonly<{
  ownerId: string;
  deploymentId: string;
  siteId: string;
  sessionId: string;
  appId: string; // Configuration, defaults, attribution and submission namespace.
}>;
type ConnectionOwner =
  | { kind: "personal"; ownerId: string }
  | { kind: "operator" };
type ClaimRef = Readonly<{
  token: string;
  incarnation: string;
}>;
type OperationAuthority =
  | { source: "request"; access: AccessContext }
  | { source: "job"; jobId: string; claim: ClaimRef }
  | { source: "event-source"; sourceId: string; claim: ClaimRef }
  | { source: "remote-cancel"; jobId: string; claim: ClaimRef };
type ConnectionUse = Readonly<{
  authority: OperationAuthority;
  connectionId: string;
  providerRegistrationId: string;
  authorityGeneration: number;
}>;
```

Access creates verified identity and request context; no public JSON can construct them or a worker claim.
Owners are unique by verified deployment/site/stable subject, with no email linking or browser metadata ownership.
A configured app selects supported defaults and attribution, not a personal grant or feature-permission boundary.
Personal resource access follows current owner equality across configured apps; operator connections require their explicit verified-site/user audience.
App IDs and opaque/null origins do not authenticate a package.
[Access](access-connections.md#app-and-connection-policy) owns current site/session/shared-audience checks.
A worker uses the persisted submitter/scope and live claim rather than the expired submitting bearer.
Event maintenance uses its stored setup authority; post-terminal remote cancellation uses only its separately bounded cleanup authority.
Neither internal authority can select a new owner, account or arbitrary connection.

## Native proxy

```ts
type ProxyRequest = {
  providerRegistrationId: string;
  endpoint: string;
  connectionId?: string;
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
  path: string;
  query?: URLSearchParams;
  headers?: Headers | readonly (readonly [string, string])[];
  body?: string | Uint8Array | Blob | FormData;
};
interface ProxyClient {
  request(request: ProxyRequest, options?: { signal?: AbortSignal }): Promise<Response>;
}
```

An endpoint names a configured destination family, resolved with validated connection context where necessary.
Connection selection follows declared no-credential, operator-shared or personal mode and never silently falls back to another identity.
Ambiguous personal selection requires an explicit visible connection; an ID alone confers no access.
File/Blob bodies contain browser-authorized bytes, not server-readable local paths.
Native body/query/paging conventions remain provider-owned and do not acquire capability schemas.
[Transport](providers-execution.md#native-forwarding-and-transport) owns recipient/header protection, byte streaming, resource cleanup and no automatic business replay.
[HTTP/SDK](events-http-sdk.md#native-request-carrier) owns automatic POST carriers for supplied GET/HEAD bodies and inspectable no-follow response carriers.

The SDK resolves `Response` at headers for supported native and service HTTP responses, including HTTP errors.
The adapter alone sets `X-Integration-Origin: provider` or `service`, strips upstream spoofing and exposes permitted useful headers.
Unmarked front-door HTTP is unclassified; local validation, network/CORS, pre-response abort or invalid carrier failures reject.
A later body read can fail after the response promise resolves, without appended service JSON or replay.
Synthetic carrier Responses have empty `url`/`statusText`, `type: "default"` and `redirected: false`; browser Headers may normalize/combine values.
Neither synthetic nor ordinary responses promise a direct provider URL or raw header fidelity.
Entrusted authenticators never appear in public checkout, logs or outputs; intentionally returned provider-created credentials remain native data under provider permissions.

## Managed capabilities and jobs

Naming a capability does not imply managed execution.
A definition declares HTTP and/or Job entrypoints, sharing the provider registration's connection mode and authorization.
No capability-specific grant or policy object is introduced.

```ts
type CapabilityRef = { id: string; version: number };
type CapabilityDefinition = {
  ref: CapabilityRef;
  providerRegistrationId: string;
  http?: {
    input: { kind: "json"; schema: unknown } | { kind: "http" };
    response: { kind: "json"; schema: unknown } | { kind: "http" };
  };
  job?: {
    inputSchema: unknown;
    resultSchema: unknown;
    inputLimitBytes?: number;
    resultLimitBytes?: number;
    executionLimitSeconds?: number;
  };
};
type CapabilityInvocation = {
  capability: CapabilityRef;
  connectionId?: string;
} & (
  | { input: unknown; body?: never; headers?: never }
  | { body?: ProxyRequest["body"]; headers?: ProxyRequest["headers"]; input?: never }
);
interface CapabilityClient {
  invoke(invocation: CapabilityInvocation,
    options?: { signal?: AbortSignal }): Promise<Response>;
}
type JobSubmission = {
  submissionId: string;
  capability: CapabilityRef;
  connectionId?: string;
  input: unknown;
};
type JobView = {
  id: string;
  appId: string;
  capability: CapabilityRef;
  state: "queued" | "running" | "waiting-provider" |
         "succeeded" | "failed" | "cancelled";
  submittedAt: string;
  startedAt?: string;
  executionDeadline?: string;
  completedAt?: string;
  blockedReason?: "reauthorization-required" | "observation-authority-unavailable";
  progress?: unknown;
  result: { availability: "not-ready" | "available" | "expired" | "none"; expiresAt?: string };
  recordExpiresAt?: string;
  error?: { code: string; message: string; details?: unknown };
  cancellation: {
    requested: boolean;
    remote: "not-requested" | "pending" | "confirmed" | "unconfirmed" | "unsupported" | "unavailable";
  };
};
```

At least one entrypoint must be registered; A19 exposes declared HTTP input/response kinds, supported modes and Job limits only where applicable.
The SDK validates the declared JSON-argument versus native-body choice and uses the existing connection/header controls; it never JSON/base64-wraps native file bytes.
JSON schemas may be reused by both entrypoints, but only a Job requires serialized input/result persistence.
A39 and `invoke` return an ordinary HTTP Response, using the declared JSON or native response contract, without persistence or Job admission deduplication.
The SDK does not parse the body by default; unsupported mode/version fails before handler invocation.
This is the sole public JobView for generated HTTP and SDK types.
`waiting-provider` has a persisted external identity and occupies no execution slot once attempt resources are disposed.
`failed` can include partial or unknown external effects; `cancelled` describes local execution/tracking and never proves rollback.
Progress/error details use bounded safe capability schemas, excluding entrusted secrets, private task context and raw exceptions.
Result availability is `not-ready` while nonterminal, `available` for a retained terminal body, `expired` after its expiry while metadata remains, or `none` for a terminal outcome without a body.
Failed/cancelled work can have an explicitly validated safe partial result.
Bodies are fetched separately; reads and callbacks never extend result or metadata expiry.
`requested` records explicit user cancellation and starts false; timeout does not set it.
Remote `pending` means optional cleanup is scheduled or executing, `confirmed` requires provider evidence, `unconfirmed` includes ambiguous dispatch, `unsupported` lacks a hook and `unavailable` lacks current authority or cleanup opportunity.
`not-requested` means no remote cleanup was selected; local cancellation alone never implies remote confirmation.
Jobs owns terminal races and cleanup status in [execution](providers-execution.md#interruption-external-tasks-and-cancellation).

[GOALS](../GOALS.md#jobs-events-and-operations) owns the 100 MB input/result, 24-hour first-start and seven/thirty-day retention policies.
Count UTF-8 serialized validated JSON for each job input/result, including embedded file bytes but only the serialization of an external reference.
Encryption/framing overhead does not shrink those application allowances.
Resolve effective limits at admission from the server caps and optional lower trusted-operation limits; no request field overrides them.
A Job-enabled capability version fixes validation/defaults, provider binding and explicit Job retry semantics, and remains available while active Jobs need its executable contract.
Ordinary HTTP versions only need in-flight draining; they impose no retained executable or comparison-schema lifetime.
No general effect taxonomy, shared pagination envelope or multi-connection capability API is required.

### Submission identity and comparison

Use a bounded opaque submission key, validated by one shared wire schema; no UUIDv4-only restriction applies.
The unique key is `(appId, ownerId, submissionId)` while metadata remains.
The semantic command is capability ID/version, schema-validated/defaulted JSON input and caller connection selection, including an explicit automatic-selection marker.
Use one maintained canonical JSON implementation and standard digest primitive with a recorded comparison format version; reject unsupported JSON values rather than invent a serializer.
Prepare validation, canonicalization, byte accounting and encryption outside authority locks and avoid repeated large copies.
Store the command digest and version with metadata, and store the resolved connection/account generation separately and immutably.
An equal currently authorized resubmission recovers the existing job before new connection selection, enabled-version checks or new-admission resource allocation.
Changed content conflicts; recovery never retargets an automatic choice after defaults change.
Preserve the comparison schema/defaults until retained metadata expires even if the executable handler is retired.
Other owners cannot recover the row, and a different app namespace does not match the submission; the same owner may still read that job through current authorized resource APIs across configured apps.
After metadata deletion the same key may admit new work; this is local admission deduplication, not provider idempotency or permission to replay interrupted execution.

## Shared server interfaces

```ts
type BundleRevision = Readonly<{
  authorityGeneration: number;
  credentialGeneration: number;
}>;
type CredentialMutationRef = Readonly<{
  id: string;
  kind: "setup" | "import" | "renewal";
  expiresAt: string;
  target:
    | { connectionId: string; expectedBundle: BundleRevision }
    | { setupTransactionId: string; expectedBundle: null };
}>;
type CredentialSnapshot = Readonly<BundleRevision & {
  runtimeContext: Readonly<Record<string, unknown>>;
  credentials: Readonly<unknown>;
}>;
interface CredentialAccess {
  withCredentials<T>(use: ConnectionUse,
    options: { deadline: string; signal: AbortSignal },
    run: (snapshot: CredentialSnapshot) => Promise<T>): Promise<T>;
}
type CallbackBinding = Readonly<{
  correlation: string;
  callbackUrl: string;
}>;
interface ProviderContext {
  signal: AbortSignal;
  request(request: ProxyRequest): Promise<Response>;
  withCredentials<T>(run: (snapshot: CredentialSnapshot) => Promise<T>): Promise<T>;
}
interface CapabilityContext extends ProviderContext {
  // Ordinary request authority and resource lifetime; no Job state.
}
interface JobContext extends ProviderContext {
  jobId: string;
  deadline: string;
  callbackBinding?: CallbackBinding; // Persisted by Jobs before initial invocation.
  reportProgress(progress: unknown): Promise<void>;
}
type ExternalTask = { externalId: string; context: unknown };
type ExecutionOutcome =
  | { kind: "complete"; result: unknown }
  | { kind: "waiting"; task: ExternalTask; nextCheckAt?: string };
type ObservationOutcome =
  | { kind: "pending"; nextCheckAt?: string; progress?: unknown }
  | { kind: "succeeded"; result: unknown }
  | { kind: "failed"; error: { code: string; message: string } };
```

An HTTP handler receives `(input, CapabilityContext)`, with input as declared JSON or filtered native headers plus an owned body stream, and returns declared JSON or a Response; a Job handler receives `(input, JobContext)` and returns ExecutionOutcome.
Only JobContext exposes job ID, progress, absolute execution deadline and optional callback binding.
The common helpers bind the original registration/connection; request fields cannot select a different identity.
M08 and M05 own the ordinary HTTP resource lifetime through body completion, while M06 adds durable attempt fences only for Jobs.
Jobs prebinds an opaque callback correlation to original job/provider/account before invoking a handler when the provider supports echoing it.
The callback URL is a configured service route; correlation is a locator and still requires source/per-task verification.
Any verifier secret is protected by Jobs and the provider adapter, never exposed in JobView or treated as an outbound credential.
Hooks return values; only Jobs validates and commits attachment or terminal outcomes.
Task context has a bounded provider schema and contains no reusable outbound authenticators.
Optional `observe(task, context)`, `cancel(task, context)` and callback interpretation reuse the same original identity; observation never submits the task again.
The remote-cancel context is restricted to the recorded task and separate cleanup deadline rather than the expired execution context.

Scoped checkout returns credentials and matching validated runtime context together.
Authority generation changes on disconnect or incompatible/unknown account replacement; proven same-account reauthorization can preserve it.
Credential generation advances on each successful bundle publication, including deliberate revalidation of identical bytes, and `lastConnectorReauthAt` changes only after successful deliberate authorization/import with supported evidence.
Neither credential renewal nor job continuation resets that timestamp.
A caller reacquires the complete snapshot rather than combining cached context with newer credentials.

`Credentials.reserveMutation` takes an already authorized setup/import/renewal intent and creates one server-owned CredentialMutationRef.
For an existing connection it locks that connection and captures its exact bundle pair; first setup instead binds the single setup transaction with no prior bundle, and atomic publication creates the new connection once.
A conflicting setup/import fails before provider work; renewal waits only within its existing deadline, with no held pool connection or hidden mutation queue.
`claimMutationStep`, `markMayHaveDispatched` and `publishBundle` require that reference and the applicable live processor ClaimRef; neither client JSON nor a provider hook may supply or rebase the expected pair.
`recoverMutation` compares the recorded mutation/revision and any old processor identity while fencing cancelled/expired work; it does not require a live lease to recover an expired claim.
Connections stores only the reference and browser/protocol correlation with its setup transaction; processor/expected-pair/dispatch ownership lives once in the Credentials mutation representation.
Renewal has no parallel attempt authority or duplicate reservation state machine.
The reservation belongs to the logical transaction across verified browser handoff, while each active processor has its own token/incarnation/lease; a lease timeout is not permission to resume an uncertain exchange.
[Competing credential mutations](access-connections.md#competing-credential-mutations) owns the exact predicate, pre-dispatch versus possibly-invalidating recovery and proven-independent-replacement rule.
Recovery of an old reference cannot make a newer independent bundle unusable or clear another reservation.
These internal coordination types are excluded from public ConnectionView/AuthorizationView and from capability contexts.

The helper is preferred; trusted custom clients may use scoped checkout but must satisfy equivalent routing, deadline, secrecy and disposal requirements.
They may not keep independent credential caches, mutate persistence or export entrusted/helper-derived secrets.
Ordinary HTTP output bodies transfer to the owning request scope; credentials, intermediate bodies and detached work cannot escape it.
Job bodies, credentials and background work cannot escape an attempt's cleanup scope.
[Attempt cleanup](providers-execution.md#managed-attempt-cleanup) requires confirmed disposal or worker termination before capacity reuse; a completed timeout Promise is insufficient.

## Live notifications and service errors

[Events](events-http-sdk.md#redis-transport-and-live-sse) owns one versioned internal envelope with source revision, trusted ingress/expiry and encoded payload bounds.
A public provider notification preserves native data inside `{id, provider, connectionId?, type, data}` with only authorized references and necessary entrusted-secret filtering.
An event ID is not a replay position; generic dedupe is optional and never replaces signature/replay verification.
Job hints contain IDs and revision hints, never result bodies; recipients read authoritative Jobs under current disclosure authority.

Service error bodies use `{error: {code, message}, requestId}` with safe fields and no raw exceptions.
Provider errors retain native meaning and status.

| Status | Service meaning |
| --- | --- |
| 400 | Malformed service control/schema. |
| 401 | Invalid/expired service authentication. |
| 403 | Denied current site or operator/shared authority. |
| 404 | Absent or non-visible private resource. |
| 409 | Changed submission, credential mutation already in progress, stale mutation or result not ready, distinguished by code. |
| 410 | Result expired while metadata remains. |
| 413 | Configured input/payload limit exceeded. |
| 422 | Connection/reauthorization required or unsupported declared behavior. |
| 431 | Request-header budget exceeded at the service handler. |
| 500 | Safe handler failure or invalid declared capability output before commitment; external effects may already exist. |
| 502 | Upstream transport/invalid response before commitment. |
| 503 | Required dependency or physical resource unavailable; no uncommitted acceptance. |
| 504 | Operation deadline or connect/header/stall timeout before commitment. |

Early parser/ingress errors may lack the service marker/body; after commitment terminate a failed body without changing status or appending JSON.
A resource error or Retry-After hint is not authorization for automatic business replay.

## Core handoffs and invariants

| Handoff | Owner and required check | Result/failure |
| --- | --- | --- |
| `Access.authenticate` | Verify session, fixed authentication expiry, current site and configured app context. | Request-local owner scope or denial. |
| `Connections.authorizeUse` | Personal owner equality or explicit current operator audience; declared mode and immutable provider association. | Current ConnectionUse or non-visible/required-connection failure. |
| `Access/Connections/Credentials.prepareRequest` | One M09 read projection applies their owned predicates coherently for session/site/config/selection/audience/bundle usability; omit secrets for no-credential mode. | Request-scoped authority and encrypted bundle for one immediate ordinary operation, zero writes or policy shared locks when usable. |
| `Credentials.checkout` | Consume that snapshot once for the immediate request operation, or freshly check background authority/generations/live claim/deadline. | Scoped immutable snapshot or bounded mutation/renewal/reauthentication failure; no cross-request permission cache. |
| `Credentials.reserveMutation/publishBundle/recoverMutation` | One current per-connection setup/import/renewal owner and immutable expected bundle pair; publication requires a live processor, recovery fences the recorded interrupted claim and affects only that pair. | Atomic bundle publication, safe release, uncertainty barrier or explicit conflict/stale result. |
| `Provider.resolveEndpoint` | Interpret only validated configuration/context. | Destination descriptor; Transport checks socket recipient and TLS before credentials leave. |
| `Jobs.admit/claim/settle` | Atomic uniqueness and [live predicates](persistence-operations.md#transactions-concurrency-and-failure). | Committed transition or explicit conflict/stale result. |
| `Events.verify/publish/deliver` | Verified source, coherent byte/age bounds and current local audience. | Best-effort live delivery/drop, independent of durable Jobs. |

State mutations and background checkout use the scoped lock order and fresh database wall time after waits.
Ordinary operations use the coherent read-only snapshot boundary, not one transaction per module; fixed expiry is checked again before use, and a later helper operation requires fresh authority.
Credential publication requires current connection authority; eligible original outcome publication does not require a still-usable provider connection.
These are distinct interfaces, so disconnect cannot accidentally reject every original result or allow an old renewal to restore secrets.
