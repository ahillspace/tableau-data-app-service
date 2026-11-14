# Round 3 final execution and integration verification

Status: bounded review of the integrated proposal, not implementation verification or user acceptance.

Review snapshot: commit `02ef97a` with aggregate SHA-256 `26d3a975bb9083dbe8c713df67f0296ef7ff3eed504ad7a1522ed4dc311027b9`.

The per-file digests in `reviews/round-2-source.json` match the reviewed goals, architecture, contracts, connections, core, execution, HTTP/SDK/events, scenarios, and decisions files.

No runtime code, tests, or external provider research were used.

## R2 fix verification

The restore procedure now advances an epoch outside the database restore boundary, quarantines restored credentials, and requires write-gap reconciliation.

In-place delegated reauthorization now verifies the same provider subject, and a different subject requires a new connection ID.

The HTTP and SDK contracts now expose the delegated authorization, attempt polling, connection listing, and disconnect journey.

The provider broker now declares capability operation allowlists and enforces a single logical effectful-operation budget.

Shared event subscription, audience, event-envelope, cursor, and resync types are now present, and feed heads use transactional ordering and a consistent baseline snapshot.

Credential profiles, lifecycle hooks, attempt states, refresh phases, connection revision semantics, and safe account labels are now represented in the integrated shared contract.

## Residual material findings

### 1. P1 - A new authority epoch does not explicitly fence old execution result reads or idempotency replays

Evidence: [contracts.md](../specs/contracts.md#L18) adds `authorityEpoch`, and [execution.md](../specs/execution.md#L102) persists it on an execution.

The execution read and replay checks in [execution.md](../specs/execution.md#L82) and [execution.md](../specs/execution.md#L113) check current context and current policy but do not require the stored execution epoch to equal the current context epoch.

The restore procedure in [connections.md](../specs/connections.md#L70) invalidates bindings, attempts, cursors and grants, but does not state how old completed execution payloads or idempotency rows are handled after a new trusted context is issued.

Counterexample: a restore rolls app policy and a completed no-credential capability result back to an older snapshot, the trusted adapter issues the same stable binding ID with the new epoch, and `GET execution` or a matching idempotency replay returns the old result under restored policy.

The persisted epoch is inert for this route unless result delivery and replay compare it.

Fix: require execution read and replay to compare the execution's stored authority epoch to the current trusted context and withhold cached payloads across epochs.

Retain unresolved-write tombstones for operator reconciliation without permitting redispatch, and keep write admission disabled after restore until the absent-row backup gap has an explicit reconciliation disposition.

### 2. P2 - Cancellation can race a definitive successful write response

Evidence: [execution.md](../specs/execution.md#L218) says cancellation only requests a stop, while [execution.md](../specs/execution.md#L227) says a dispatched write becomes `outcome_unknown` unless definitive success was already committed.

A provider can return a validated definitive success after `cancelRequestedAt` is committed but before the worker commits the result.

In that ordering the service knows the write succeeded, yet the text can classify it as unknown because success was not committed before the cancellation request.

This conflicts with the definition in [execution.md](../specs/execution.md#L158) that unknown means the service cannot prove success or failure.

Fix: specify that a validated definitive provider success may transition `running` to `succeeded` despite a pending cancellation request, and reserve `outcome_unknown` for cases where the provider outcome is actually indeterminate.

### 3. P2 - Cursor page limits are neither required by the capability type nor exposed in discovery

Evidence: [contracts.md](../specs/contracts.md#L83) makes `pageLimits` optional on a cursor-capable definition, and `CapabilityDescriptor` in [core.md](../specs/core.md#L30) has no page-limit field.

The execution prose requires each cursor capability to declare a finite default and maximum page size, while [http-sdk-events.md](../specs/http-sdk-events.md#L99) says discovery returns safe limits.

Counterexample: a registry accepts `pagination: 'cursor'` with no `pageLimits`, and the browser SDK can discover that pagination exists but cannot discover the capability's declared maximum.

Fix: make cursor pagination a discriminated capability variant that requires `pageLimits`, and include those bounds in the public descriptor while keeping server validation authoritative.

### 4. P2 - Provider-operation schemas are required in prose but absent from the provider transport type

Evidence: [core.md](../specs/core.md#L69) declares each operation with effect, authorization method, and response size only.

The broker API in [contracts.md](../specs/contracts.md#L98) accepts `parameters: unknown` and returns `data: unknown`, while [core.md](../specs/core.md#L81) says operation parameter and response schemas are declared and validated.

Counterexample: a second provider implementer follows the declared types and creates an operation without input or response schemas, but the registry cannot perform the validation that the prose requires.

Fix: add required input and response schemas to a named provider-operation definition and specify that the broker validates both before returning an operation result to a capability handler.

## Areas with no further material contradiction found

The round-two dispatch boundary now distinguishes durable intent from wire send and makes the one-effectful-operation subset enforceable by the provider broker.

Execution idempotency retention now preserves unresolved writes without automatic expiry, while resolved-key expiry is explicitly bounded and client retries are limited to that window.

The cancellation marker prevents lease recovery from reissuing a cancelled read, and ambiguous writes cannot be retried after dispatch intent without a provider guarantee.

The cursor path now separates browser cursors from provider cursors, binds them to caller and logical connection revision, and constructs the public page after storing the server continuation.

The event path now has explicit audiences, current-state resync requirements, inbox/outbox transactionality, per-feed commit ordering, and a baseline resync cursor read under a consistent snapshot.

The connection lifecycle routes and SDK methods align with the domain calls in the shared contract.

## Deferred decisions and evidence limits

The trusted front-door transport, stable browser binding and trusted rebinding mechanism, Tableau environment compatibility, secret-management service, and concrete provider guarantees remain explicit external or operational choices.

These choices do not invalidate the internal domain contracts, but they remain blockers to browser deployment or real credential use.

This review establishes design consistency only and does not establish code correctness, live provider behavior, deployment safety, or user acceptance.

## Final frozen-source closeout

Verified against commit `6d22222` and frozen source SHA-256 `423a982749928069c49a464806dc24d37395b4dc332fb93b2d9faff13facc02f`; the reviewed shared-file hashes match `reviews/round-3-source.json`.

The execution read and idempotency replay now compare the stored execution epoch with both the caller and deployment epoch, deny old-epoch payloads, preserve old keys as deduplication barriers, and gate post-restore writes until backup-gap disposition.

A current fenced worker may commit a definitive validated success despite a prior cancellation request, while terminal records remain fenced from stale workers and only indeterminate effects or unusable success payloads become `outcome_unknown`.

`PaginationDeclaration` now distinguishes non-paginated capabilities from cursor capabilities with required finite limits, and discovery publishes the declared bounds.

`ProviderOperationDefinition` now requires input and response schemas, and registry plus broker validation cover both sides while retaining effect uncertainty for a possibly applied write.

All four targeted residual findings are closed in the frozen specification; this confirms only document consistency and does not establish implementation behavior or user acceptance.
