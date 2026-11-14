# Historical architecture choices

This document is frozen historical evidence, not current build guidance.
Use the [current specification](../README.md) for requirements and the [current policies and engineering gates](../planning/decision-register.md) for status.
The text below describes the previous documentation state and is not maintained.


Status: user decision walkthrough complete through REWRITE-043, with accepted policy and remaining engineering mechanisms distinguished.
The [accepted records](rewrite/README.md) remain unchanged historical authority; later records govern conflicting earlier scope.
The [historical integration note](../reviews/accepted-025-integration.md) extends the historical traceability through REWRITE-025.

## Accepted architecture direction

| Choice | Reason and boundary |
| --- | --- |
| Native authenticated proxy foundation | Apps use native APIs without per-endpoint capability implementations or universal response translation. |
| Shared provider protocols/configuration/hooks | Common lifecycle stays central; provider differences are narrow, and compatible changes preserve connections. |
| Preferred conditional Tableau ownership | Recognize the same verified owner across apps without local accounts; actual OAuth support and acceptable experience remain unproven. |
| Explicit app/connection authority | Cross-app recognition, app IDs, origins, and connection IDs do not automatically grant access. |
| Owner-bound provider authorization | A transferred locator cannot attach another account; deliberate external-account choice/replacement is allowed. |
| Coordinated refresh with uncertainty | Stale results cannot revive old authority; possible token rotation needs supported recovery or reconnection. |
| Helper plus trusted scoped credential checkout | Custom SDKs are possible without duplicating renewal or exposing provider credentials to browsers. |
| Caller/author-owned business retries | Proxy/SDK do not automatically repeat writes; capabilities default to no automatic retry without a generic effect framework. |
| Single managed-job worker path | One API and one worker from one codebase with Postgres; proxy/auth stay direct and external waits release capacity. |
| Owned Jobs table and worker | REWRITE-035 locks the Jobs table as the sole durable queue and a bounded worker loop; no library-selection gate remains. |
| Simple retained-job deduplication | Equal app/owner/submission IDs recover the same row; protection ends when that row is removed. |
| Native or capability-defined pagination | Optional helpers and server-held sensitive state where needed, without universal encrypted cursors. |
| Tableau Data App consumer boundary | REWRITE-034 removes external application-server clients, delegation grants and outbound notification recipients; registered provider reads/writes, internal capabilities and operator controls remain. |
| Jobs outlive browser sessions | New submissions/starts require usable authority; provider revocation does not trigger active-job cancellation machinery. |
| Configurable job retention | Seven-day results and thirty-day terminal metadata by default; no deletion of unfinished jobs solely for age. |
| Optional live event forwarding | SSE to authorized Data Apps, native payloads, explicit possible loss, no event archive/replay or separate application-server delivery. |
| Maintenance-window key replacement | Authenticated encryption and tested interruption recovery without online rotation complexity. |
| Ordinary database recovery | Accept the lost backup interval without a custom restore subsystem or runbook. |
| Connection-specific provider context | Validated setup/authorization/discovery context stays with the authorized connection and resolves approved destinations with revision fencing. |
| Provider-specific event lifecycle | Declare setup ownership and only necessary creation/renewal/retirement hooks; preserve native API access and separate provider-source and browser-stream lifetimes. |
| Ordinary schema and process ordering | One migration owner prepares installation/upgrades before API traffic or worker claims; shutdown stops admission/claims before dependency closure. |
| Final review safeguards | REWRITE-026 accepts encrypted auxiliary secrets, immutable credential/context checkout, refresh and destination safety, protected optional event delivery, and ordinary schema/process ordering; remaining mechanisms and numeric limits are not implicitly accepted. |
| Persistent service sessions | REWRITE-027 preserves convenient reload/new-tab/return visits with secure restoration; it supersedes memory-only sessions without restoration as the default, while mechanisms require evidence and REWRITE-043 now fixes the seven-day verified-authentication maximum. |
| Trusted Tableau sites | REWRITE-028 admits every verified user of an enabled Cloud URL/site-ID pair, without viewer-email filtering; a narrow protected management interface serves the user's external staff-only enrollment page. |
| Simple provider-consent expiry | REWRITE-029 keeps normal session renewal but terminates attempts after true session/transaction expiry or authority loss; no consent-resume or credential-staging branch. |

## Architecture-owner planning recommendations

The [readiness map](../implementation-readiness.md) records the recommended mechanism, rationale, tradeoff and behavioral acceptance criterion for each material choice.
The canonical specifications recommend an app-bound access bearer and initial-login candidate, service-wide trusted-site admission, explicit owner/app/site connection authority, immutable credential/context snapshots, one short database authority guard, durable renewal phases, incremental native HTTP, read-only external observation, in-process event fanout, post-commit job-ID notifications, and ordinary migration/offline encryption tools.
The access-bearer/login candidate requires a concrete persistent restoration/renewal mechanism under REWRITE-027 before it is a complete session design.
The owned job-table worker is accepted and locked under REWRITE-035.
The authority guard remains a D06 engineering choice to validate against accepted authorization invariants; it is not a new product-policy approval.
New limits remain unapproved starting proposals except the user-selected proposed 5 GB response setting, seven-day result/thirty-day metadata defaults and REWRITE-040/041 job payload/execution caps and REWRITE-043 service-authentication maximum.

REWRITE-036 accepts historical owner job/result reads after provider disconnect under current session/app/site/ownership authority and configured retention.
D05 is settled; disconnect does not delete saved results or restore provider access.
Connection replacement fences the old revision and never retargets accepted jobs.
Backend grant continuity and approval-screen proposals are removed by REWRITE-034.
The runtime-context secret clarification and event safeguards are accepted in [REWRITE-026](rewrite/REWRITE-026-accepted-hardening-safeguards.md).
Session continuity is accepted in REWRITE-027 and the seven-day maximum since verified Tableau authentication in REWRITE-043; secure transport/restoration mechanics remain engineering and platform-evidence work.
Site-wide eligibility is accepted in REWRITE-028; dedicated registry-management credentials and adapter routes are recommended mechanisms, with external enrollment-page mechanics outside scope.
Provider-consent expiry is resolved in REWRITE-029: restart an expired attempt instead of adding dedicated resume machinery.
REWRITE-037 accepts local-file uploads through the Data App, streamed through this service with bounded buffering and configurable limits; no numeric upload cap is selected.
REWRITE-040 supersedes the payload default/ceiling model in REWRITE-038/039: one configurable input cap and one result cap, currently 100 MB (100,000,000 bytes) each.
Trusted capability limits may only lower those caps; omission uses the cap and no per-request caller override exists.
REWRITE-041 selects the environment-configured 24-hour execution cap from first start, including external waiting; optional trusted capability limits may only lower it and omission uses the cap.
Remaining media/redirect details and job cancellation/correlation interfaces need design/engineering work; the job engine, retained-owner disclosure and limit-fallback policies are selected.
Capacity policy is accepted under REWRITE-026: no per-app capacity limits or unnecessary throttling; operational bounds protect the whole service from actual resource exhaustion.
Concrete sizing and admission mechanics remain engineering work rather than an open product-policy decision.
The user favors a small deployment without a large orchestration layer and explicitly selected the owned Postgres queue under REWRITE-035 after hearing the viable library alternative.

Tableau custom registration/identity evidence and actual published-browser experience are the principal open gate.
The candidate does not prove silent SSO, current-workbook attestation, automatic Tableau logout/account synchronization or Server/Desktop support.
Actual provider fields/lifecycle semantics, host ingress/process supervision, key custody and measured performance also require evidence.
Session persistence/renewal, the remaining walkthrough decisions and those empirical/provider-specific choices remain open; plans must expose them rather than treating earlier recommendations as accepted defaults.
Alternative ownership modes, identity linking, routine endpoint restrictions, business effect frameworks, signed submission windows, universal pagination, durable event history and restore generations remain outside scope.

## Review and implementation boundary

This rewrite changes design documents only.
The previous canonical baseline and original manifest are preserved under [design/pre-proxy-rewrite-2026-11-08](../design/pre-proxy-rewrite-2026-11-08/README.md), and previous review records retain their original scope.
The [final hardening disposition](../reviews/final-hardening.md) records the independent comparison and complete-journey review; its new snapshot identifies the revised source.
Document convergence does not establish user acceptance of proposed mechanisms or live runtime/provider/Tableau behavior.
Implementation uses accepted contracts and official protocol/library/provider documentation, not private research or third-party implementation source.

## Native streaming update

[REWRITE-030](rewrite/REWRITE-030-streaming-and-large-responses.md) accepts incremental HTTP response streaming and an explicit proposed 5 GB response configuration.
It supersedes the initial buffered-response/8 MiB/no-streaming proposal and the thirty-second total deadline for healthy active streams.
Local-file upload support and streaming direction are accepted under REWRITE-037.
Provider-specific upload mechanics, media authorization/redirect behavior, byte-count representation and numeric buffer/idle settings remain design or evidence work.

The [build review pack](../planning/README.md) maps modules, draft endpoints, flows, limitations and implementation dependencies without closing the remaining choices.

REWRITE-042 removes separate user-facing service logout and per-app/global signout design while preserving expiration, server-side revocation and correct-account restoration.
Closing a page cleans up local resources without revoking tokens, disconnecting providers or cancelling jobs.
REWRITE-043 subsequently selects the environment-configured seven-day (604800-second) maximum since verified Tableau authentication, unaffected by ordinary activity/access refresh; successful new verified authentication permits a new session.
The user decision walkthrough is complete; no separate idle timeout or another lifetime policy approval is required.
