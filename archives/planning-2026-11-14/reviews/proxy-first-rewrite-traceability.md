# Proxy-first rewrite traceability

Status: architecture-owner draft completed for independent accepted-decision review on 2026-11-08.
This consolidates accepted requirements into eleven canonical files; it does not claim runtime verification, design convergence, or user acceptance of proposed mechanisms.
The accepted decision records and earlier review artifacts remain unchanged.

## Preservation

Before editing, copied the exact eleven paths listed by `reviews/astra-revised-source.json` into `design/pre-proxy-rewrite-2026-11-08/`, preserving relative paths.
Also copied the exact original manifest to that archive's `reviews/astra-revised-source.json`.
Verified every original source file's SHA-256 against that manifest before copying.
The historical manifest still identifies its original source, not this rewrite.

## Accepted-decision mapping

| Record | Canonical treatment | Removed or bounded machinery |
| --- | --- | --- |
| [001](../decisions/rewrite/REWRITE-001-durable-execution.md) | [Architecture: application shape/execution](../architecture.md#application-shape); [jobs: durable admission and interruption](../specs/providers-execution.md#durable-admission-and-execution). | Inline-only receipts replaced by durable managed jobs; no agent runtime or workflow engine. |
| [002](../decisions/rewrite/REWRITE-002-shared-provider-flows.md) | [Provider registration/shared flows](../specs/providers-execution.md#provider-registration-and-shared-flows). | No bespoke full provider lifecycle or automatic invalidation on every configuration/code edit. |
| [003](../decisions/rewrite/REWRITE-003-tableau-identity-and-sdk.md) | [Common session/Tableau](../specs/access-connections.md#common-session-and-tableau-direction); [embedded SDK](../specs/events-http-sdk.md#embedded-browser-sdk-and-backend-client); [validation gate](../verification.md#tableau-and-browser-validation-gate). | No local accounts or separate authentication extension; no unsupported silent/no-extra-login claim. |
| [004](../decisions/rewrite/REWRITE-004-authorization-attachment.md) | [Provider authorization transaction](../specs/access-connections.md#provider-authorization-transaction). | Locator/state alone cannot attach; same-external-account restriction replaced by deliberate authorized account choice. |
| [005](../decisions/rewrite/REWRITE-005-credential-refresh-safety.md) | [Refresh coordination/interruption](../specs/access-connections.md#refresh-coordination-and-interruption); [persistence transactions](../specs/persistence-operations.md#transactions-concurrency-and-failure). | Retains refresh-specific uncertainty and stale-result fencing; no blind lease-expiry replay. |
| [006](../decisions/rewrite/REWRITE-006-helper-default-and-credential-access.md) | [Shared server interfaces](../specs/contracts.md#shared-server-interfaces); [backend helpers](../specs/providers-execution.md#backend-helpers-and-pagination). | Removes blanket secret-getter prohibition for trusted code; no browser/raw-key endpoint or direct storage mutation. |
| [007](../decisions/rewrite/REWRITE-007-simple-errors-and-opt-in-retries.md) | [Interruption/retries](../specs/providers-execution.md#interruption-external-tasks-and-cancellation); [service errors](../specs/contracts.md#live-notifications-and-service-errors). | Removes effect taxonomy, stable step keys, business dispatch markers, mandatory reconciliation, and automatic interrupted-handler replay. |
| [008](../decisions/rewrite/REWRITE-008-basic-job-deduplication.md) | [Managed jobs contract](../specs/contracts.md#managed-capabilities-and-jobs); [admission](../specs/providers-execution.md#durable-admission-and-execution). | Removes signed windows, separate tombstones, perpetual duplicate guarantees, and proxy-wide deduplication. |
| [009](../decisions/rewrite/REWRITE-009-capability-defined-pagination.md) | [Backend helpers and pagination](../specs/providers-execution.md#backend-helpers-and-pagination). | Removes universal page envelope, encrypted continuation protocol, and compulsory cursor storage. |
| [010](../decisions/rewrite/REWRITE-010-authenticated-proxy-foundation.md) | [Goals purpose](../GOALS.md#purpose-and-scope); [PRD outcome](../PRD.md#required-outcome); [native proxy contract](../specs/contracts.md#native-proxy). | Replaces capability-only browser access; capabilities/jobs/events are optional additions and other application backends can coexist. |
| [011](../decisions/rewrite/REWRITE-011-provider-event-delivery.md) | [Optional ingress](../specs/events-http-sdk.md#optional-event-ingress); [SSE/webhooks](../specs/events-http-sdk.md#live-sse-and-signed-webhooks). | Replaces browser polling default and mandatory normalized events; no inference that proxy use creates event support. |
| [012](../decisions/rewrite/REWRITE-012-maintenance-window-key-rotation.md) | [Encryption and maintenance](../specs/persistence-operations.md#encryption-and-maintenance-replacement). | Removes online rotation requirement; offline procedure/tool/key custody remain proposed or unresolved and require drills. |
| [013](../decisions/rewrite/REWRITE-013-standard-database-recovery.md) | [Standard durability/backup loss](../specs/persistence-operations.md#standard-database-durability-and-backup-loss). | Removes restore gates/generations/quarantine, mandatory mass reconnection, and project restore runbook. |
| [014](../decisions/rewrite/REWRITE-014-tableau-preferred-cross-app-identity.md) | [Identity and authority](../architecture.md#identity-and-authority); [Tableau validation](../verification.md#tableau-and-browser-validation-gate). | Preserves conditional preferred Tableau direction; no dual ownership implementation, automatic fallback/linking, or automatic cross-app grants. |
| [015](../decisions/rewrite/REWRITE-015-native-provider-access-by-default.md) | [Native forwarding](../specs/providers-execution.md#native-forwarding-and-transport). | No routine per-operation allowlists; destination/secret controls and explicit service audiences remain. |
| [016](../decisions/rewrite/REWRITE-016-caller-controlled-proxy-retries.md) | [Native forwarding](../specs/providers-execution.md#native-forwarding-and-transport); [refresh](../specs/access-connections.md#refresh-coordination-and-interruption). | No proxy business retry options/classifier, implicit post-refresh replay, or invented proactive renewal threshold. |
| [017](../decisions/rewrite/REWRITE-017-native-provider-responses.md) | [Native proxy](../specs/contracts.md#native-proxy); [HTTP surface](../specs/events-http-sdk.md#proposed-http-surface). | No universal native response/error envelope; minimal secrecy/transport filtering and distinguishable service failures. |
| [018](../decisions/rewrite/REWRITE-018-backend-api-credentials.md) | [Backend principals/grants](../specs/access-connections.md#backend-principals-and-grants); [backend client](../specs/events-http-sdk.md#embedded-browser-sdk-and-backend-client). | No team-wide key, browser-session reuse, arbitrary user impersonation, or implied raw credential download. |
| [019](../decisions/rewrite/REWRITE-019-single-managed-job-execution-path.md) | [Application shape](../architecture.md#application-shape); [admission](../specs/providers-execution.md#durable-admission-and-execution). | One API/worker/Postgres model; removes dual inline/worker jobs and avoids queueing ordinary proxy/auth requests. |
| [020](../decisions/rewrite/REWRITE-020-job-lifetime-and-provider-revocation.md) | [Disconnect/active work](../specs/access-connections.md#disconnect-checkout-and-active-work); [jobs](../specs/providers-execution.md#durable-admission-and-execution). | Browser expiry does not end jobs; revocation blocks admission/start without active cancellation broadcasts/barriers, credential resurrection, or automatic tracking termination. |
| [021](../decisions/rewrite/REWRITE-021-job-retention.md) | [Result retention](../specs/providers-execution.md#results-and-retention); [storage retention](../specs/persistence-operations.md#data-retention-and-observability). | Seven-day bodies/thirty-day terminal metadata configurable; no rerun on result expiry or age-based unfinished-job deletion. |
| [022](../decisions/rewrite/REWRITE-022-simple-live-event-forwarding.md) | [Live SSE/webhooks](../specs/events-http-sdk.md#live-sse-and-signed-webhooks); [event state ownership](../specs/persistence-operations.md#state-ownership). | Removes raw archive, replay cursors/counters/namespaces, multi-day delivery rows/windows, and mandatory resync-capability wrappers; current-state refresh can miss unreconstructable events. |

## Unsettled details

The session transport, persistence/lifetime/logout, app binding, and exact secure popup/callback mechanism remain unresolved pending Tableau/browser evidence.
The preferred Tableau flow is conditional; no alternative owner mode is implemented or accepted by this rewrite.
Backend key provisioning/verification/replacement and the personal-owner grant approval/lifetime mechanism remain unresolved.
The account-replacement/grant invalidation rule is explicitly a conservative architecture proposal, not a newly accepted policy.

Proxy body/upload/streaming support, exact headers, limits, and provider-specific credential filtering require implementation choices and tests.
The job library, claims/lease timing, queue settings, deadline values, precise cancellation interface, and external observation scheduling remain unresolved.
Refresh claims/conditional writes are proposed minimal mechanisms for accepted safety, with provider-specific recovery still requiring evidence.

Event duplicate handling, signing/key lifecycle, interprocess notification handoff, buffer limits, and small retry count/delay remain unresolved.
No raw retention or retry-window numbers were adopted.
Encryption algorithm/envelope, key custody, offline migration tooling/batching, interruption checks, and backup-key retention remain unresolved.
Only the accepted job retention defaults are numeric operational policies.

## Evidence and review limits

No proposal-pack machinery was adopted wholesale; the rewrite uses accepted records and preserves non-conflicting baseline requirements.
Historical accepted records may still say the baseline is unchanged because they record the pre-rewrite discussion; they were deliberately not edited.
Existing historical reviews/manifests remain evidence about their original versions.
The next independent review must check accepted-decision compliance and cross-module consistency before source comparison.
Local link checking establishes only document presence and file-link validity, not semantic consistency or platform behavior.
There is no application, provider, Tableau, browser, SSE, webhook, worker, cryptographic, restore, or deployment verification to report as passing.
