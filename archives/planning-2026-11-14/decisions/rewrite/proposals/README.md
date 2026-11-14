# Remaining rewrite recommendations

Status: architecture recommendations prepared for user review on 2026-11-08.
These are not accepted decisions, canonical specifications, implementation results, or permission to deploy.
The [accepted rewrite records](../README.md) govern where they conflict with the older baseline.
No canonical specification or accepted record was changed to adopt this proposal pack.

## Subsequent user decision

[REWRITE-013](../REWRITE-013-standard-database-recovery.md) rejects PROPOSAL-001's custom restore handling and runbook.
Backup restoration may lose changes since the backup; the rewrite must follow that accepted scope rather than the restore proposal below.

## Recommended choices and reasons

| Topic | Recommendation | Plain-English reason |
| --- | --- | --- |
| [Restore](PROPOSAL-001-maintenance-restore.md) | Controlled maintenance, reset short-lived authority and delivery state, recover credentials only with independent current evidence. | Removes a universal recovery-generation protocol while refusing to revive old revocations or pretend lost jobs never ran. |
| [Browser identity](PROPOSAL-002-browser-identity-and-authorization.md) | Opaque server sessions with memory-only browser tokens; deliberate popup attachment and account replacement. | Avoids a user directory and routine third-party-cookie dependency, with reload/idle convenience explicitly traded off. |
| [Proxy and providers](PROPOSAL-003-proxy-and-provider-extension.md) | Native bounded HTTP forwarding, app/provider grants, shared protocol flows, and small optional hooks. | Frontend authors keep native API flexibility without writing a backend capability per endpoint. |
| [Jobs](PROPOSAL-004-durable-jobs.md) | Postgres queue, bounded worker claims, no automatic interrupted-handler replay, durable external-task observation. | Supports long-running work without a workflow engine or exactly-once claims. |
| [Events](PROPOSAL-005-events-and-delivery.md) | Seven-day replay, authenticated fetch SSE, Postgres wakeups, and twenty-four-hour signed webhook attempts. | Covers browser reconnect and ordinary backend outages with finite storage and explicit duplicate/order limits. |
| [Backend consumers](PROPOSAL-006-backend-consumers.md) | Individual backend API credentials, explicit app/service grants, and exact delegated grants. | Other backends can participate without reusing browser tokens or impersonating arbitrary Tableau users. |
| [Credentials and operations](PROPOSAL-007-credentials-maintenance-and-deployment.md) | Retain strict refresh coordination, use authenticated encryption, rotate offline, deploy one API and one worker initially. | Keeps the safety needed for rotating credentials while using accepted downtime to remove online migration complexity. |

Numbers for sessions, retention, deadlines, leases, body limits, and retry schedules are proposed starting defaults, not user-approved targets or measured capacity.
The records explain costs, simpler alternatives, concrete rewrite implications, and evidence needed for support claims.
Implementation details such as exact route spelling, popup handshake, and selected library version remain subordinate to these contracts and live validation.

## Coverage of accepted records and open details

| Input | Remaining detail covered |
| --- | --- |
| REWRITE-001 | PROPOSAL-004: job state, queue/claims, external waiting, cancellation, deadlines, interruption, long-running authority. |
| REWRITE-002 | PROPOSAL-003: shared protocol/configuration/hooks, permission limits, compatible versus credential-breaking changes. |
| REWRITE-003 | PROPOSAL-002: session transport/lifetime, app grants, current-viewer limits, live Tableau and UX gate; PROPOSAL-004: job authority beyond session expiry. |
| REWRITE-004 | PROPOSAL-002: launch/completion proof, expiry, replacement races, explicit account choice, identity unavailable. |
| REWRITE-005 | PROPOSAL-007: minimal refresh phases/claims/fencing and uncertain renewal; PROPOSAL-001: stale credentials after restore. |
| REWRITE-006 | PROPOSAL-003: scoped helper/custom credential checkout and cooperation limits; PROPOSAL-006: distinction from remote backend credential export. |
| REWRITE-007 | PROPOSAL-004: success/error, opt-in bounded retries and no implicit abandoned-handler replay; PROPOSAL-003: no proxy write replay. |
| REWRITE-008 | PROPOSAL-004: atomic submission identity/comparison, duplicates/conflicts, retention; PROPOSAL-001: lost history limits. |
| REWRITE-009 | PROPOSAL-003: native cursor passthrough and optional scoped sensitive-state helper; PROPOSAL-004: paging input remains capability-defined. |
| REWRITE-010 | PROPOSAL-003: native proxy, destinations, app/service scope, headers/errors/uploads/streams; PROPOSAL-006: backend grants. |
| REWRITE-011 | PROPOSAL-005: ingress, replay/order/dedup, SSE auth/fanout/backpressure, webhook retries; PROPOSAL-006: backend authentication/audiences. |
| REWRITE-012 | PROPOSAL-007: encrypted data, envelope/key custody, offline rotation, interrupted migration and backup keys. |
| X01 | PROPOSAL-001: restore without a universal recovery generation, current policy/credential evidence, sessions/jobs/events and lost history. |
| Deployment boundary | PROPOSAL-007: hosting responsibilities, process ownership, maintenance deployment, secrets, limits, observability. |

## Consequential limits that remain open

Custom Tableau Cloud OAuth client/resource/identity support and the actual embedded browser experience require live validation.
OAuth identity is not proof of the current Tableau viewer or workbook; a requirement for that equality cannot be met by these recommendations alone.
The recommended memory-only session loses continuity on reload and closes an idle event-only tab after thirty minutes, potentially requiring a user Continue/sign-in action.
That tradeoff must be judged in the real experience test rather than presented as a settled UX.

No provider credential is automatically safe after database rollback, no missing job record proves absence of remote work, and no event feed reconstructs unreceived upstream events.
Restore, encryption rotation, proxy upload/streaming, and browser SSE remain procedures/contracts awaiting implementation and drills.
The first real provider and selected hosting environment supply evidence needed to finalize their supported features, custody, network controls, and operational limits.

## Review and next stage

Review these recommendations as a finite set before promoting them into accepted decision records.
The later architecture owner can use the coverage table to rewrite all canonical specifications coherently, removing superseded machinery rather than appending exceptions.
Independent scenario review and user acceptance are separate from live implementation verification.
No code, package installation, publication, or deployment is part of this deliverable.

The [independent review](independent-review.md) records corrections and remaining limits.

## Subsequent ownership investigation

[PROPOSAL-008](PROPOSAL-008-ownership-modes.md) examines selectable ownership establishment, common session infrastructure, and the conditional Tableau experience test.
It is unaccepted and was added after the seven-proposal independent review; that review does not cover this addition.

## Subsequent event scope decision

[REWRITE-022](../REWRITE-022-simple-live-event-forwarding.md) rejects PROPOSAL-005's multi-day event retention, browser replay, and durable delivery-window machinery.
Use live forwarding, short configurable retries, and current-state refresh where supported.
