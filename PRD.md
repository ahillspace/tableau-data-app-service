# Product requirements

Status: accepted product and architecture direction with the optional-Job revision integrated.
Owner consistency and viewer checks are document evidence, not implementation verification; historical independent reviews cover earlier snapshots.
[GOALS](GOALS.md) owns policy values and scope; this document owns the observable journeys and completion meaning.
No application or deployment exists.

## Required outcome

A developer includes the embedded SDK in a Tableau Cloud or Tableau Server Data App, establishes a verified service session and connects an authorized external account.
The app uses native provider endpoints without implementing a backend wrapper for every operation.
The service owns identity, credential custody/renewal, approved routing, reusable optional capabilities, explicitly chosen durable jobs and live events; the author owns app behavior and provider business semantics.
App IDs select configuration/defaults and attribution, not package proof or per-app feature permissions.
Personal resources follow the verified owner across configured apps, and shared operator accounts require explicit verified-site/user audiences.

## User journeys

| Journey | Required behavior | Owning contract |
| --- | --- | --- |
| Native access | Read/write native paths, queries, headers, responses/errors and pagination without capability handlers. | [Transport](specs/providers-execution.md#native-forwarding-and-transport). |
| Cloud and Server identity | Verify deployment/site/stable user through supported deployment adapters; a separate authorizing login suffices. | [Access](specs/access-connections.md#common-session-and-tableau-direction). |
| Return visits and multiple apps | Restore current authority across supported reload/new-tab/return journeys, preserve account separation and share personal ownership without app-use grants. | [Session contract](specs/access-connections.md#recommended-session-prototype). |
| Trusted sites | Existing protected enrollment integration registers deployment/site identity; all verified users pass eligibility without email/per-user/per-app signup. | [Registry](specs/access-connections.md#trusted-site-registry-administration). |
| Shared/public APIs | Use explicitly available shared accounts or no-credential mode without personal login or fallback after personal failure. | [Connection selection](specs/access-connections.md#connection-selection-and-state). |
| Provider setup | Support shared OAuth, personal static import, operator-managed and derived lifecycle with atomic credentials/context. | [Credential variants](specs/access-connections.md#credential-variants-and-confidentiality). |
| Reauthorization | Preserve account authority for proven same-account reauth; replacement with unknown/different identity cannot retarget jobs. | [Generations](specs/access-connections.md#reauthorization-and-generations). |
| Uploads/media | Stream browser-selected files, large responses and native provider HTTP streams with bounded buffering and honest abort/late failure. | [Transport](specs/providers-execution.md#native-forwarding-and-transport). |
| Reusable ordinary capability | Invoke registered provider code with current request authority and receive JSON or streamed HTTP, without Job persistence or separate grants. | [Ordinary invocation](specs/providers-execution.md#ordinary-capability-invocation). |
| Deliberate durable work | Explicitly admit once, recover equal submissions, run in a worker and track persisted external tasks without resubmission. | [Jobs](specs/providers-execution.md#durable-admission-and-execution). |
| Cancellation/recovery | Distinguish local terminal outcome, unknown remote effects and optional bounded remote-cancel evidence. | [Recovery](specs/providers-execution.md#interruption-external-tasks-and-cancellation). |
| Retained history | Rediscover/read own retained work across configured apps and after provider disconnect under current disclosure authority. | [Disclosure](specs/access-connections.md#disclosure-and-trust-boundary). |
| Live events | Receive verified native data through lossy Redis/SSE; reconnect with possible-loss signals and fetch current state where possible. | [Events](specs/events-http-sdk.md#redis-transport-and-live-sse). |
| Provider extension | Add a second provider using static configuration and necessary narrow hooks, reusing identity/credentials/transport/jobs/events. | [Extension](specs/providers-execution.md#provider-extension-checklist). |
| Operations | Replicas coordinate through Postgres, survive honest interruption and enforce compatible migration/offline key maintenance. | [Operations](specs/persistence-operations.md). |

## Accepted policy and architecture

[GOALS](GOALS.md) is the single policy reference for seven-day verified authentication, configurable connector freshness with no invented default, 100 MB input/result caps, 24-hour first-start deadline and seven/thirty-day retention.
It also owns no automatic business replay, retained owner reads, private entrusted secrets, allowed native provider-created credentials and the Data App-only consumer boundary.
The input/result caps, execution deadline and saved-result retention apply only to deliberate Jobs; ordinary calls/downloads may stream directly.
No arbitrary response-size ceiling, pending-job quota, per-user/app/IP quota or speculative future-result reservation is introduced.
Physical capacity, header/socket/byte budgets and provider limits still require measured enforcement.

The accepted topology is one codebase with API and worker roles, initially one each and replica-safe from the start, with authoritative Postgres and optional Redis Pub/Sub.
Ordinary capability handlers run in the API request with shared transport and no durable recovery; Job handlers run in the worker process; confirmed whole-process termination can interrupt siblings when cooperative cleanup fails.
That initial interruption tradeoff is accepted, while per-handler child isolation remains a measured extension.
Core maintenance still runs without Jobs; scans/hooks for optional background features are conditional.
Redis failure degrades live events only; native requests, ordinary capabilities, durable Jobs and external callbacks remain independent.
No host, price, traffic level, SLA or fixed concurrency value is selected.

## Evidence and completion

The [published Cloud observation](specs/access-connections.md#published-identity-evidence) supports initialization and separate backend-verified login/site/user identity.
It does not establish silent restoration, account switching, media, long-term behavior, Server compatibility or a complete service implementation.
Viewer equality is not required and no Tableau feature-request dependency is assumed.
Silent-login hardening remains conditional on a simple transparent solution without adverse UX/embed/browser/performance cost; otherwise its concrete tradeoff must be surfaced.
Actual package opaque origins, popup/window correlation, CSP and network behavior must be tested rather than replaced with impossible exact-origin opener checks.

[Verification](verification.md) defines runnable future gates for both platforms, two APIs/two workers, real Postgres races, Redis failure/loss, large payloads and host recovery.
Support claims apply only to observed supported journeys; optional jobs/events do not delay early native-access evidence.
Document consistency and viewer checks can establish a reviewable design, not implemented behavior or user acceptance of the delivered experience.
Application implementation/deployment requires separate authorization.
