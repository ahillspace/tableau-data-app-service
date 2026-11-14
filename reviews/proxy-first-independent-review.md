# Independent review of the proxy-first rewrite

Status: completed bounded specification review on 2026-11-08.
Outcome: no blocking accepted-decision omissions or cross-module contradictions found.
No canonical corrections are required by this review.
This conclusion permits the separate source comparison to proceed; it does not establish final implementation readiness, user acceptance of proposed mechanisms, or runtime verification.

## Scope and source identity

Read the project instructions, GOALS, REWRITE-001 through REWRITE-022 and their index, all eleven rewritten canonical documents, and the [rewrite traceability](proxy-first-rewrite-traceability.md).
The author explicitly froze the canonical draft before this review began.
The reviewed canonical documents and accepted records match their entries in [the frozen source manifest](proxy-first-frozen-source.json), whose recorded source digest is `0eb5421135087d9e856303111d16bb2318622a6be7c18325c1e0dfb6fef016ee`.
A local SHA-256 comparison found no mismatch among those 34 files.
The traceability file reviewed separately has SHA-256 `756ad1c9758780ec937d9d30480a30ea3df495751aa86db29380d74efc7743c6`.
The manifest also includes historical proposal files; their inclusion does not make them governing requirements or part of this review's accepted-decision comparison.

This review checks the accepted direction and consistency of complete cross-module journeys.
It does not compare another platform, repeat external research, prescribe unaccepted features, or approve unresolved implementation details.
No canonical document was edited by this reviewer.

## Decision-by-decision findings

All rows below mean that the accepted requirement is represented consistently in the reviewed documents, not that its implementation has passed a test.

| Decision | Evidence and finding |
| --- | --- |
| REWRITE-001 | [Managed jobs](../specs/providers-execution.md#durable-admission-and-execution), lines 69-120, describe durable admission, local worker execution, external task IDs, released worker capacity, cancellation, and honest interruption. |
| REWRITE-002 | [Provider registration](../specs/providers-execution.md#provider-registration-and-shared-flows), lines 6-22, keeps shared protocols, declarative configuration, narrow hooks, and deliberate incompatible-change treatment. |
| REWRITE-003 | [Common session](../specs/access-connections.md#common-session-and-tableau-direction), lines 7-25, and [browser validation](../verification.md#tableau-and-browser-validation-gate) preserve conditional Tableau identity, embedded SDK, and required experience evidence. |
| REWRITE-004 | [Authorization transaction](../specs/access-connections.md#provider-authorization-transaction), lines 68-93, retains initiating owner/app/session binding, single-use completion, expiry, explicit replacement, and deliberate external-account choice. |
| REWRITE-005 | [Refresh coordination](../specs/access-connections.md#refresh-coordination-and-interruption), lines 117-134, retains shared claims, persisted dispatch uncertainty, revision fencing, and provider-supported recovery or reconnection. |
| REWRITE-006 | [Server interfaces](../specs/contracts.md#shared-server-interfaces), lines 135-162, permit trusted scoped credential checkout while retaining shared renewal, authority, and custom-client obligations. |
| REWRITE-007 | [Interruption and retries](../specs/providers-execution.md#interruption-external-tasks-and-cancellation), lines 98-112, default retries off and forbid silent interrupted-handler replay without imposing a business-effect framework. |
| REWRITE-008 | [Job identity](../specs/contracts.md#managed-capabilities-and-jobs), lines 122-133, and [admission](../specs/providers-execution.md#durable-admission-and-execution), lines 74-84, provide atomic retained-row deduplication, canonical comparison, and current disclosure checks. |
| REWRITE-009 | [Pagination](../specs/providers-execution.md#backend-helpers-and-pagination), lines 61-67, permits native or capability-defined paging, optional helpers, and sensitive server-held state only where needed. |
| REWRITE-010 | [Native proxy](../specs/contracts.md#native-proxy) and [SDK example](../specs/events-http-sdk.md#embedded-browser-sdk-and-backend-client), lines 85-106, support native use without capability handlers; jobs and events remain optional. |
| REWRITE-011 | [Event ingress and delivery](../specs/events-http-sdk.md#optional-event-ingress), lines 6-53, preserve verified native payloads, authorized SSE audiences, signed backend delivery, and separate job truth. |
| REWRITE-012 | [Encryption maintenance](../specs/persistence-operations.md#encryption-and-maintenance-replacement), lines 66-83, retains authenticated encryption, stopped credential users, partial-replacement detection, key custody, and drills before support claims. |
| REWRITE-013 | [Backup loss](../specs/persistence-operations.md#standard-database-durability-and-backup-loss), lines 85-92, accepts lost changes without restore generations, quarantine, mass reconnection, or a project restore runbook. |
| REWRITE-014 | [Common session](../specs/access-connections.md#common-session-and-tableau-direction), lines 15-25, preserves same-owner recognition with app-specific authority and excludes assumed dual ownership or automatic fallback. |
| REWRITE-015 | [Native forwarding](../specs/providers-execution.md#native-forwarding-and-transport), lines 26-42, uses provider permissions without routine endpoint restrictions while keeping destination, connection, and credential protections. |
| REWRITE-016 | [Proxy retry boundary](../specs/providers-execution.md#native-forwarding-and-transport), lines 49-52, leaves business repetition to callers and separates shared renewal from request replay. |
| REWRITE-017 | [Native HTTP responses](../specs/events-http-sdk.md#proposed-http-surface), lines 76-81, preserve status/body/useful headers and distinguish service-origin failures without a universal business envelope. |
| REWRITE-018 | [Backend principals](../specs/access-connections.md#backend-principals-and-grants), lines 27-43, use separate attributable API credentials and explicit app/connection grants without viewer impersonation or an inbound key for webhook-only receivers. |
| REWRITE-019 | [Application shape](../architecture.md#application-shape) and [job admission](../specs/providers-execution.md#durable-admission-and-execution), lines 71-79, keep one API, one worker, one codebase, and Postgres, with all managed jobs on workers. |
| REWRITE-020 | [Disconnect and active work](../specs/access-connections.md#disconnect-checkout-and-active-work), lines 136-151, and [job authority](../specs/providers-execution.md#durable-admission-and-execution), lines 86-91, separate admission/start, active execution, and current disclosure. |
| REWRITE-021 | [Results and retention](../specs/providers-execution.md#results-and-retention), lines 123-131, preserve configurable seven-day bodies/thirty-day terminal metadata, unfinished jobs, explicit expired results, and bounded deduplication. |
| REWRITE-022 | [Live forwarding](../specs/events-http-sdk.md#live-sse-and-signed-webhooks), lines 28-53, uses small configurable retries and possible loss, with current-state refresh instead of archives, replay, or multi-day delivery queues. |

## Cross-module checks

The native browser and backend journey goes from verified principal/app context through authorized connection selection and shared renewal to native forwarding and native responses.
Neither endpoint registration nor a managed job is necessary for that journey.
Backend API credentials do not grant raw provider credential retrieval.

Authorization completion, replacement, refresh, and disconnect use consistent ownership and stale-update boundaries.
The refresh-specific durable uncertainty accepted in REWRITE-005 is retained without becoming the rejected business-effect framework.
Credential maintenance remains distinct from caller-controlled business retries.

Managed admission, worker start, active execution, external observation, and private disclosure remain separate.
Browser expiry does not cancel accepted work.
Revocation prevents new starts and new use of revoked credential storage without imposing active cancellation or automatic termination of external tracking.
Known external-task observation does not repeat task submission, and failed/interrupted execution does not guarantee that external actions had no effect.

Submission recovery depends on retained job identity and current disclosure authority.
Result expiry does not rerun work, and metadata deletion ends duplicate protection.
Live notifications do not become an alternate source of job state or durable history.

Maintenance key replacement retains its accepted interruption-recovery obligation while ordinary backup restoration accepts the lost interval.
Neither contract reinstates the rejected restore subsystem.

## Remaining limits

The documents explicitly leave session/app binding, Tableau support and experience, backend grant/provisioning mechanics, transport support, job library/claim details, event delivery implementation, and encryption tooling unresolved.
The account-change grant rule and concrete lifecycle mechanisms are identified as proposals.
This review does not promote them to accepted policy or close their stated validation dependencies.

Verification performed here consists of document reading, accepted-record comparison, cross-module reasoning, and source-hash comparison.
No application tests, browser journeys, provider calls, worker execution, SSE/webhook delivery, encryption drills, backup restoration, or deployment checks were run.
