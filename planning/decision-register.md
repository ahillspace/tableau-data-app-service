# Decision register

Status: accepted architecture and policies, with specified mechanisms and explicit unverified runtime assumptions.
This optional-Job/read-only routing revision has owner consistency and viewer checks; historical independent review applies only to its recorded snapshot.
Acceptance does not certify implementation or delivered user experience, and no new approval gate is introduced.
This register maps owners and evidence rather than repeating normative contracts.

## Decision and engineering status

| ID | Topic | Status | Accepted policy or specified mechanism | Engineering holds |
| --- | --- | --- | --- | --- |
| D01 | Access / SDK sessions | Policy accepted; partially evidenced | Verified Cloud/Server identity, persistent sessions and fixed authentication maximum; no viewer-equality requirement. | Actual returning-client binding, full platform/session/account journeys. |
| D02 | Jobs / process architecture | Accepted; contract specified | Explicitly selected Jobs on the owned Postgres table; ordinary capabilities use API requests; replicable roles retain background sibling interruption. | Real replica races, scans, hung-attempt and host termination proof. |
| D03 | Resource protection | Policy accepted; sizing unverified | Physical bytes/memory/socket/pool budgets without app/user/IP/count quotas or future reservations. | Near-cap JSON/crypto/driver copies, mixed workload and total deployment capacity. |
| D04 | Native transport | Accepted; contract specified | Node byte streaming, native GET/HEAD-body and no-follow response carriers, no arbitrary response cap. | Actual Cloud/Server media, header/runtime/ingress/provider proof. |
| D05 | Retained owner disclosure | Accepted; contract specified | Current owner/site/shared audience reads after disconnect, independently of provider usability or app attribution. | Current disclosure races and payload preparation/release proof. |
| D06 | Scoped authority and coordination | Accepted architecture; contract specified | Coherent zero-write ordinary snapshots; ordered mutation/background/disclosure locks, audience parents and live claim/generation predicates. | Real Postgres contention/absence/deadline/replacement races. |
| D07 | Jobs limits and recovery | Policy accepted; contract specified | Fixed first-start deadline, semantic admission, persisted external waits and separate bounded remote cleanup. | Cancellation/callback/send-before-ID/result and recovery tests. |
| D08 | Provider lifecycle | Policy accepted; contract specified | Shared setup, separate authority/credential generations and explicit reauth time, native new-credential output allowed. | Provider continuity/rotation/discovery/static/derived evidence. |

## D01 - Persistent identity and sessions

**Policy summary:** Service sessions have a configurable seven-day (604800-second) maximum since verified Tableau authentication, with secure return visits and no separate inactivity/signout product.

[Access](../specs/access-connections.md#recommended-session-prototype) owns the shared transaction/window handoff, fixed timestamp and restoration evidence gate.
App IDs/null origins do not prove package identity, and an opaque opener cannot be authenticated by exact origin.
Separate authorizing login is sufficient; viewer equality is not required.
The [Cloud observation](../specs/access-connections.md#published-identity-evidence) establishes only initialization and separate backend-verified identity/site IDs.
Cloud and Server need actual supported adapter/browser journeys before support claims, with no assumed Tableau feature dependency.
A cookie and arbitrary new null-origin initiation proof cannot restore bearer authority; the returning-client binding must be demonstrated before A07 is finalized.
Adopt silent-login hardening only after a simple transparent prototype proves no adverse UX/browser/embed/performance impact; otherwise surface the concrete tradeoff.
CHIPS alone is not Tableau embedding proof, and no browser ancestry claim or approval screen resolves this gate.
This is remaining engineering evidence, not a new approval UI or a request to reopen session lifetime policy.

## D02 - Owned jobs and worker recovery

**Policy summary:** The Owned Postgres Jobs table serves explicitly selected durable work; ordinary capabilities use HTTP on the API with no saved input/result or separate permissions, while initial Job handlers share the worker and may interrupt siblings without replay.

[Execution](../specs/providers-execution.md#scheduling-and-claims) owns bounded scans, earliest-due timers and optional lossy hints that cannot strand committed work.
[Cleanup](../specs/providers-execution.md#managed-attempt-cleanup) owns reserved control capacity, hung-Promise detection, external watchdog and confirmed termination before capacity reuse.
Core expiry/mutation maintenance still needs an owner without Jobs; optional Job scans/source hooks run only when applicable.
The [API-only maintenance placement recommendation](../architecture.md#worker-deployment-recommendation) is not an adopted topology change.
That initial background process tradeoff is accepted; its suitability for predominantly I/O-waiting trusted handlers is an unverified workload assumption.
Per-attempt child isolation is an extension if measured disruption warrants it, not an initial mandatory topology or unresolved product choice.

## D03 - Actual resource bounds versus product quotas

**Policy summary:** Bound measured physical memory, byte queues, sockets and database capacity across the deployment, without app/user/IP/count quotas, pending-job ceilings or speculative future-result reservations.

[Resource admission](../specs/persistence-operations.md#resource-admission-and-large-payloads) owns preparation outside locks and actual allocation failure.
Large JSON/string/schema/canonicalization/crypto/driver copies can coexist even when network streams use backpressure.
Choose active-attempt capacity and pool reserves from mixed-load evidence, including replica replacement overlap, rather than copying a fixed slot count.
No hosting platform, traffic, price or SLA is selected.

## D04 - Native transport and media

**Policy summary:** Preserve native streamed HTTP, local-file uploads and inspectable no-follow carriers without an arbitrary total response cap or automatic business replay.

[Transport](../specs/providers-execution.md#native-forwarding-and-transport) and [wire codecs](../specs/events-http-sdk.md#native-request-carrier) own methods, representation bytes and coherent physical header budgets.
Existing primitive probes observed browser manual-redirect opacity, GET-body rejection, a synthetic POST-to-GET carrier, raw/decoded gzip differences and header expansion past a tested parser limit.
They did not test this application, actual providers, published Tableau native transport or deployed ingress.
HTML media elements cannot simply attach SDK bearer headers; actual authorized media/download consumption remains an explicit evidence gate without a reusable query-bearer or whole-video Blob shortcut.
Deliberately configured private providers remain allowed within the scoped recipient policy.

## D05 - Retained owner disclosure

**Policy summary:** Owners can read retained jobs/results after provider disconnect under current service identity, verified site, ownership/shared audience and retention, across configured apps without personal app-use grants.

[Disclosure](../specs/access-connections.md#disclosure-and-trust-boundary) owns current checks, and [Jobs retention](../specs/providers-execution.md#results-and-retention) owns immutable expiry.
Authorize before payload load and recheck before logical release without locks across large preparation/network drain.
Reading saved data does not reconnect the provider or require credential checkout.

## D06 - Scoped authority transactions

**Policy summary:** Ordinary usable-credential requests take a coherent read-only snapshot with zero writes and no policy shared-lock commit; scoped ordered locks and fresh live predicates remain for mutations, background work and final saved-result disclosure.

[Persistence](../specs/persistence-operations.md#transactions-concurrency-and-failure) owns the exact order and operation table.
Transactional FOR SHARE protects unchanged authority against updates; parent locks cover absent child memberships where serialization is required.
Ordinary snapshot membership reads deliberately accept overlapping revocation, while revocation committed before the snapshot denies.
Unrelated connections need not serialize, and bulk validation/encryption/streaming stays outside authority locks.
The ordinary statement snapshot or background checkout commit precedes remote dispatch; later revocation cannot recall it, while stale credential publication is fenced independently of eligible original result publication.
Real race/lock-wait tests establish correctness; no benchmark of a global guard is a prerequisite for this design.

## D07 - Job limits, external work and cancellation

**Policy summary:** For explicitly submitted Jobs only, configure 100 MB (100000000-byte) input/result caps and 24 hours from first execution start, with lower trusted-operation limits, no initial queue expiry and honest unknown outcomes.

[Shared contracts](../specs/contracts.md#managed-capabilities-and-jobs) owns byte accounting and semantic idempotency; [execution](../specs/providers-execution.md#interruption-external-tasks-and-cancellation) owns the complete state machine.
A lost initial claim interrupts; a persisted task can resume read-only observation; send-before-ID remains unknown.
Prebound correlation covers early callbacks where supported, otherwise provider lookup/redelivery is required.
First eligible terminal commit wins, and post-terminal remote cancellation has separate bounded claim/deadline/issued status that cannot revive work or repeat uncertain cancellation.
Started work can continue past ordinary session/connector freshness expiry under original account/current connection authority; new starts still obey freshness.

## D08 - Provider setup and reauthorization

**Policy summary:** Shared OAuth/static/operator/derived lifecycles keep entrusted secrets private; verified same-account reauth can preserve authority generation, while credential generation and explicit connector-reauth time remain separate.

[Access lifecycle](../specs/access-connections.md#reauthorization-and-generations) owns continuity, setup matrix and unset-interval behavior.
No invented periodic connector default applies, and refresh never resets deliberate reauth.
Unknown/new identity replacement cannot inherit old jobs; provider permissions remain authoritative without a service feature-policy mirror.
Native provider-created credentials may be returned deliberately, with only the narrow known entrusted-secret retrieval exception.
[Credential mutation arbitration](../specs/access-connections.md#competing-credential-mutations) serializes existing-connection setup/import/renewal using an exact captured bundle pair.
One shared mutation representation owns setup/import/renewal processor/revision/dispatch state; setup retains browser correlation, without a parallel renewal state machine.
Possibly invalidating interruption cannot leave the affected old bundle falsely usable, while stale publication/recovery cannot overwrite or poison a newer independent bundle.

## Evidence gates that do not need new product policy

| Gate | Proof needed | Owner and effect |
| --- | --- | --- |
| E01 | Actual supported Cloud and Server identity adapters, opaque-origin handoff, returning-client proof, account separation and fixed expiry; Cloud separate login is partial evidence only. | Access/SDK; blocks unsupported platform/session claims, not accepted topology. |
| E02 | Actual native uploads/media/carriers/header profiles and fetch-SSE through browser/CSP/ingress; optional Redis lifecycle and loss. | HTTP/Events/operations; blocks claims for the affected path. |
| E03 | Official provider credential/context/continuity, routing, task/cancel/source verification and uncertainty semantics. | Provider owner; blocks only that unsupported integration behavior. |
| E04 | Two APIs/two workers, real Postgres races and bounded scans, Redis age/buffers/current audience, mixed near-cap payloads and whole-deployment budgets. | Jobs/Events/Persistence; no unmeasured capacity guarantee. |
| E05 | Independent liveness/termination, compatible overlap/versions, migration and interrupted offline rekey with all writers/restart excluded. | Operations; required before host/recovery support claims. |

## Keep the scope small

The [build plan](build-plan.md) proves native Cloud/Server access, second-provider reuse and actual ingress early, then adds optional jobs/events through their own gates.
No extra platform, feature-permission product, workflow engine, durable event delivery or generic protocol stack is justified by missing evidence.
Rejected candidates are a running Nango token vault/evaluation, tenant management, service quotas/rate shaping/cooldowns/fairness and custom post-restore session purge/access reconfirmation.
Cross-request credential caching and per-owner Redis routing are deferred until measured need, not open adoption tasks.
