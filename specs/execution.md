# Execution service

Status: proposed component contract for review, not an implementation plan or acceptance record.

This specification owns execution admission, persistence, worker coordination, idempotency, cancellation, and outcome recovery.

The shared service remains one Postgres-backed deployment, and the execution module is a domain module rather than a separately deployed service.

## Requirements, recommendations, and assumptions

User requirements are a shared internal service for a solutions engineering team, no customer tenancy, typed capability execution, bounded input and output, safe pagination, cancellation, explicit retry behavior, honest write uncertainty, and a provider-independent core.

The user selected Node.js LTS, strict TypeScript, Fastify, Postgres, Kysely, and modular services as the working technology direction.

Recommendations in this document are a single persisted execution interface for every capability, durable idempotency records, Postgres-backed worker leases, fencing before provider dispatch, and no automatic write retry without a provider idempotency guarantee.

Proposed initial numeric limits and retention windows are defaults for review, not user-stated requirements or verified capacity figures.

The trusted request adapter remains unresolved, and this component accepts only the `TrustedContext` constructed by that adapter.

No runtime, provider, Tableau deployment, front door, or customer system is constructed by this specification.

## Ownership and boundaries

The execution service owns the execution record, idempotency index, state transitions, admission limits, scheduling, retry decisions, deadlines, cancellation requests, and execution result persistence.

The app and policy owner supplies current app registration and capability authorization decisions, while the provider registry supplies immutable capability definitions and provider dispatch clients.

The connection service owns encrypted credentials, connection lifecycle, authorization refresh concurrency, and connection revisions.

The execution service never reads or stores credentials directly, and it receives a server-only `ExecutionGrant` and an `AuthorizedProviderClient` through the frozen cross-module boundary.

A provider adapter validates provider responses, classifies failures as definitive or ambiguous, and implements provider idempotency only when its guarantee is explicit.

The provider transport checks current connection state and execution fencing immediately before outbound dispatch, while acknowledging that the local check cannot be atomic with a provider wire send or recall a request already accepted by an external service.

## One persisted execution interface

Every invocation is admitted as a durable `Execution` resource, including fast reads and writes.

There is no separate inline-only execution route, and HTTP submission does not wait for provider completion.
Every accepted read and write has a durable execution resource because one lifecycle gives both effects the same admission, cancellation, deadline, result-validation, status, and restart semantics.
A durable read record is not required to prevent duplicate effects, and the required idempotency key is an admission deduplication handle for reads rather than an effect guarantee.
This choice adds a Postgres write and bounded input/result retention to each read, but avoids a second inline contract with different cancellation, timeout, error, and client recovery behavior.
The team should revisit this tradeoff if measured read volume or result sensitivity outweighs the benefit of a single execution lifecycle.

`POST /v1/executions` returns `202 Accepted` with the persisted execution snapshot and a `Location` header naming its read route.

The worker may advance the record before the response is sent, so the returned snapshot can already be `running` or terminal while retaining the same resource identity.

A repeated request with the same idempotency key and equivalent effective input returns `200 OK` with the existing execution and `Idempotency-Replayed: true`.

The caller reads progress with `GET /v1/executions/{executionId}`, requests cancellation with `POST /v1/executions/{executionId}/cancel`, or uses the SDK's `waitForExecution` convenience function.

A high-level SDK `execute` helper, if included, submits first and then waits on that same persisted resource rather than introducing a second execution contract.

The initial contract does not define a streaming response or a synchronous timeout mode.

## Admission and authorization

The adapter constructs `TrustedContext` from a verified request and never from caller JSON, query parameters, an origin, or an app or binding identifier supplied by the browser.

The execution service checks that the context has not expired and that its app and binding remain valid before any admission or replay response.

Admission validates the request envelope, capability ID and version, capability input schema, input byte limit, idempotency key format, optional connection selection, and optional pagination controls.

The app and policy module confirms that the app is enabled and the exact capability version and identity mode are currently enabled for it.

Identity mode is fixed by the capability definition, and the caller cannot switch between `none`, `app`, and `delegated` identities.

For `none` and `app` identity, a caller-supplied `connectionId` is `INVALID_INPUT`.

For `app` identity, the connection is resolved only from current app registration and must be in `ready` state for the configured provider.

For `delegated` identity, an explicitly selected connection must belong to both the current app and current binding, and a missing usable connection returns `CONNECTION_REQUIRED` or `REAUTHORIZATION_REQUIRED` as appropriate.

A connection ID is a selector only, and never proves possession or authority.

A missing trusted context returns `UNAUTHENTICATED`, while an inaccessible connection or execution returns `NOT_FOUND` to avoid disclosing its existence.

The server re-evaluates app policy, capability enablement, connection ownership, connection state, and provider authorization immediately before dispatch.
Reading an execution also rechecks current context, app enablement, exact capability binding, connection ownership and state, current provider authorization, and equality with the original logical connection generation before disclosing any stored result.
A credential refresh for that same logical connection is allowed when current authorization still satisfies the capability, but account or owner replacement is not.
If the caller still owns the execution but its connection now requires reauthorization or is disabled, the read returns a safe authorization error without the cached result.
If app capability access or ownership has been revoked, the execution is indistinguishable from a missing resource and returns `NOT_FOUND`.

A denied or stale execution does not invoke the provider and records the corresponding safe terminal error when an execution resource already exists.

A policy or credential change does not silently substitute another identity or connection.

## Admission transaction and idempotency

The caller supplies a unique idempotency key for each intended execution, and the key is scoped to the pair `(appId, bindingId)`.

The server stores a one-way digest of the key, a canonical request fingerprint, the execution ID, and timestamps, rather than logging the key or treating it as authority.
The fingerprint includes the effective logical connection generation but excludes credential revision changes that preserve the same logical connection.

The fingerprint covers the capability ID and version, schema-normalized input, pagination controls, requested delegated connection, and effective identity and connection ID selected by current policy.

The fingerprint excludes rotating credential material and the connection revision so a token refresh alone does not make an otherwise identical retry conflict.

The record separately captures the app registration revision, logical connection generation, and credential revision used at admission for audit and dispatch fencing.
A credential refresh may advance the credential revision without changing the logical connection generation.
A change in external subject or delegated owner advances the logical generation and prevents cached results from being replayed under the replacement identity.

Input normalization applies schema defaults before deterministic serialization, so JSON object key order does not change an idempotency comparison.

The server writes the execution and unique idempotency mapping in one Postgres transaction before returning acceptance.

Concurrent submissions with the same key serialize through the unique constraint, then return the existing resource when fingerprints match or `CONFLICT` when they differ.

An idempotency replay still requires a currently valid trusted context, the current app capability binding, current connection ownership and state, and current provider authorization for the original identity and connection.

If any of those checks fail, the service returns the current safe authorization error and does not disclose the prior execution snapshot or result.

A replay never creates a second provider call and does not consume another active execution slot.

The server keeps a compact idempotency tombstone for at least the execution result retention period, and the reviewed service policy must define what happens to a key after that period.

The recommended initial policy is to retain key digests and fingerprints for 30 days, retain execution details for 30 days, and document that a retry outside the retention period is not protected from duplicate effects.

A caller handling an ambiguous write must inspect its execution resource before submitting a new key, and a caller must not assume that a key is protected after the published retention window.

The orchestrator should resolve the retention window before accepting the final shared contract because the frozen contract does not define it.

## State and persisted data

The public states remain the frozen `ExecutionState` values: `accepted`, `running`, `succeeded`, `failed`, `cancelled`, and `outcome_unknown`.

The execution record also stores immutable request identity, effective connection reference, creation and update times, deadline, attempt count, lease and fencing metadata, dispatch-intent time, cancellation-request time, terminal error, and validated result where applicable.

The record stores no credential, provider account ID, raw provider error body, authorization token, or unredacted stack trace.

The input and output are bounded JSON values required for restart recovery and client results, and their capability schemas must reject credential material and unnecessary secrets.

Stored execution input and output are subject to the same access controls and database protection as other service data, and logs contain only safe identifiers, sizes, states, and allowlisted error codes.

`accepted` means the execution is committed for processing but no worker has claimed it.

`running` means a worker owns a live lease, and does not imply that the provider has received a request.

`succeeded` means a provider result was received, validated against the output schema and byte limit, and committed.

`failed` means the service has a definitive failure or can prove that the requested effect did not occur.

`cancelled` means the service can prove that processing stopped before an external effect could occur.

`outcome_unknown` means a write may have occurred but the service cannot prove success or failure, or a confirmed external write succeeded but its public result could not be safely validated and committed.
A malformed or oversized response after an effectful success is never reported as `failed`, because that state would falsely assert that no effect occurred.
The service records `outcome_unknown` with `inspect_execution` guidance when it cannot produce the full validated success result promised by the capability contract.

`outcome_unknown` is terminal for the generic execution engine, and no blind retry is made from that state.

## Worker concurrency and crash recovery

Workers claim accepted executions in a short Postgres transaction using row locks and a finite lease, then perform provider I/O outside the transaction.

Each claim increments an attempt and fencing token, and all later updates require the current token so an expired worker cannot overwrite a newer decision.

Before the provider call, the worker rechecks current policy and connection ownership and commits a dispatch-intent marker tied to its fencing token.

The transport checks the current connection state and execution fence immediately before sending the provider request.
The service commits a durable dispatch-intent marker before that final transport check and before any provider wire send.
The marker records that an outbound effect may follow, not proof that bytes were sent or accepted.
A disconnect committed after dispatch intent cannot promise that no later wire send will occur, because the database transaction and an external network send cannot be atomic.
The final local fence prevents stale workers from changing service state, but it cannot recall an accepted request or close the race between the last local check and provider receipt.
Therefore any write that has crossed dispatch intent and lacks a provider idempotency guarantee is treated as potentially applied after a crash, timeout, abort, or transport loss.

A worker crash before dispatch intent permits lease expiry and safe requeue because the service has not started an external call.

A worker crash after dispatch intent is treated as ambiguous for writes unless the provider adapter can safely repeat the same provider idempotency token or prove that no request was sent.

A crash after a read dispatch may be retried according to the capability's `read_safe` policy and its remaining deadline only when no cancellation request is pending.

A write with `provider_idempotent` retry classification may be sent again only with the same downstream idempotency token and only while the provider's documented deduplication guarantee ensures at most one externally visible effect.
The repeated transport call is a recovery attempt for the same bounded logical operation and is permitted only when it preserves that single-effect invariant.

A write without that guarantee transitions to `outcome_unknown` after an ambiguous dispatch, timeout, abort, connection loss, or expired worker lease.

The worker enforces the capability deadline and maximum attempts, and records a safe terminal error when either is exhausted.

The Postgres execution row is the durable queue and state source of truth, so a service restart resumes accepted work and resolves expired leases according to the dispatch marker and retry policy.
No external queue, workflow engine, scheduler service, or separate worker deployment is required by this proposal.
A service-local worker loop claims bounded batches from Postgres, and lease recovery uses the same execution records.

## Retry, cancellation, and write uncertainty

The descriptor's retry policy is authoritative: `never` disables automatic retries, `read_safe` permits bounded retries for reads, and `provider_idempotent` requires an explicit provider guarantee for repeated effects.

The generic service does not infer safety from HTTP verbs, timeouts, an error message, or a caller retry request.

A definitive provider response is classified as `failed` only when the adapter can establish that the requested effect did not happen.

An ambiguous write response is stored as `outcome_unknown` with retry advice `inspect_execution`, and a new execution is not created automatically.

The caller may inspect the execution and use an external system's own reconciliation path before deciding whether a new write is appropriate.

`POST /v1/executions/{id}/cancel` is idempotent and returns the current execution resource.

Cancelling an `accepted` execution atomically transitions it to `cancelled` before any worker can claim it.

Cancelling a `running` execution records `cancelRequestedAt` and signals its `AbortSignal`, but the request is only a request to stop work and is not a promise to reverse a provider effect.

If a running read stops and the worker confirms the stop, it becomes `cancelled`.
If lease recovery finds a pending cancellation request, it never requeues the read; it marks the read `cancelled` and discards any uncommitted result.
A read may have reached the provider before cancellation, but repeating it after the cancellation request is prohibited.

If a running write has not crossed dispatch intent, it becomes `cancelled` after the worker confirms the stop.
If lease recovery finds a pending cancellation request before dispatch intent, it marks the write `cancelled` without dispatch.

If a write has crossed dispatch intent, it becomes `cancelled` only when the adapter proves no effect occurred; otherwise it becomes `outcome_unknown` unless a definitive success was already committed.
A pending cancellation request prevents any retry after dispatch intent unless the provider idempotency contract explicitly makes the same logical operation safe to finish.

A cancellation arriving after a terminal transition returns that terminal state without changing it.

## Limits and errors

The service rejects oversized HTTP bodies before parsing and enforces the stricter of the route limit and capability `maxInputBytes`.

The service validates serialized output against the output schema and `maxOutputBytes` before storing or returning it.

Cursor pagination is limited to read capabilities, and each descriptor declares a finite default and maximum page size.

The execution deadline cannot exceed the descriptor's `maxDurationMs`, and the deployment also has a finite global ceiling.

All active work is bounded by deployment, app, and binding concurrency limits, and admission beyond a limit returns `RATE_LIMITED` with a safe `retryAfterMs` when a retry estimate is available.

Recommended initial review values are 1 MiB maximum HTTP body, a default 256 KiB capability input ceiling, 1 MiB capability output ceiling, page size 50 with a maximum of 100, a two-minute global execution ceiling, and finite app and binding concurrency caps.

These recommendations require measurement against expected Data App payloads before implementation and are not vendor capability claims.

API errors use the frozen `Problem` allowlist and never include raw provider messages, provider URLs, credentials, or stack traces.

Admission and transport errors use the HTTP mapping in `http-sdk-events.md`, while a completed execution failure is returned as a successful read envelope containing `ExecutionView.error`.

## Extension contract

A provider adds immutable capability definitions with input and output schemas, identity mode, authorization requirement, effect, duration and byte bounds, pagination declaration, and retry classification.

A capability implementation receives its input, deadline, abort signal, execution ID, and one execution-scoped authorized provider client.

A provider idempotency implementation derives a stable opaque key from the execution ID and documents the provider guarantee and its expiration window.

A provider may later add a provider-specific status or reconciliation operation, but the core does not invent a universal write reconciliation API.

Adding a second provider or capability must not require changes to the execution state machine or an identity fallback.

## Synthetic traces

### Repeated write submission

Binding `binding-7` submits synthetic capability `ledger.record@1` with idempotency key `k-92` and input `{reference: "case-4", amount: 12}`.

The service validates current app policy, records execution `exec-41` and the key fingerprint in one transaction, and returns `202` with `accepted`.

The browser loses the response and resubmits the same request with `k-92`.

The service verifies the current binding, finds the matching fingerprint, returns `200` with `exec-41`, and dispatches no duplicate provider request.

A submission using `k-92` with amount `13` returns `409 CONFLICT` and leaves `exec-41` unchanged.

### Ambiguous write after transport loss

A worker claims `exec-41`, commits dispatch intent, and sends the synthetic write.

The provider accepts the write but the connection closes before a response reaches the worker.

If `ledger.record@1` declares `never`, the execution becomes `outcome_unknown` with `inspect_execution` retry advice.

The SDK returns that terminal resource to the caller, which must reconcile through a provider-specific supported path before initiating a new write.

### Cancellation and process restart

A worker claims a read execution and commits dispatch intent.

The caller requests cancellation, and the service stores `cancelRequestedAt` and aborts the provider call.

If the worker confirms the read stopped, it commits `cancelled`; if the process dies first, lease recovery sees `cancelRequestedAt`, commits `cancelled`, discards an uncommitted result, and does not reissue the read.

## Acceptance scenario coverage

The shared goal's no-credential, explicit app-credential, and delegated-identity scenarios are enforced at admission and again before dispatch.

The shared goal's cross-binding connection isolation is enforced through current owner checks on admission, replay, execution reads, cancellation, and dispatch.

The shared goal's refresh and disconnect races are handled through connection revision checks, dispatch fencing, bounded leases, and honest write uncertainty.

The shared goal's paginated read and write scenario uses the same persisted execution record, input and output validation, limits, cancellation endpoint, and explicit retry rules.

The shared goal's second-provider scenario is covered by the narrow capability and authorized-client extension contract.

Implementation verification and user acceptance remain pending because this workspace contains proposals only.
