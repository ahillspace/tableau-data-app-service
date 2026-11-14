# Independent review of the remaining recommendations

Status: proposal review completed on 2026-11-08; recommendations remain unaccepted.
This is design inspection, not implementation verification or approval of the unchanged canonical specifications.

## Scope and disposition

Reviewed PROPOSAL-001 through PROPOSAL-007 and the proposal index against GOALS.md and the accepted REWRITE-001 through REWRITE-012 records.
Focused on consequential authorization, interruption, restore, delivery, and proportionality questions.
No remaining blocking contradiction was identified in this bounded review after the corrections below.
The pack is ready for user discussion and later integration by the architecture owner.

## Findings resolved during review

| Finding | Correction verified in the final proposal |
| --- | --- |
| A job execution deadline was also applied to result disclosure, contradicting the longer result-retention period. | PROPOSAL-004 now checks disclosure authority and retention independently of the execution deadline. |
| Documenting absent event deduplication would not satisfy the still-governing event acceptance scenario in GOALS.md. | PROPOSAL-005 now requires a stable source ID or valid bounded deduplication key; ingress without either remains unsupported unless the requirement is explicitly changed. |
| A signed, broadly bound replay cursor added a protocol without a demonstrated authorization need. | PROPOSAL-005 now uses a validated replay namespace, position, and subscription-view revision; current server-derived authorization governs every disclosure. |

## Most consequential recommendations

1. Preserve the live Tableau identity and experience gate.
   The proposed session proves the authorizing account, while current-viewer and workbook identity remain unproven.
   Memory-only persistence and idle expiry are deliberate UX proposals requiring the user's assessment.
2. Keep shared credentials and backend authority explicit.
   An app ID, allowed origin, or successful Tableau login alone does not grant service-connection access.
   Named subject audiences, service bindings, and exact backend grants supply the missing policy without a user-directory platform or impersonation API.
3. Separate durable execution from permission to repeat it.
   PROPOSAL-004 fails an interrupted started handler by default and resumes observation only when an external task identity is durable.
   This reconciles durable workers with retries off and avoids a mandatory effect/recovery framework.
4. Treat restore as an authority loss requiring evidence.
   PROPOSAL-001 does not equate successful decryption, provider acceptance, fresh login, or operator acknowledgement with current local authorization.
   Uncertain revocations and rotating credentials require disabled connections, reconnection, or independently justified recovery; old work and delivery backlogs do not restart automatically.
5. Keep event guarantees finite and honest.
   PROPOSAL-005 provides bounded replay and webhook attempts, current authorization, stable delivery identities, and explicit resync limits.
   Internal wakeup sweeps and external-task status reads do not reintroduce browser polling.
6. Use the accepted maintenance window to simplify operations.
   PROPOSAL-007 retains strict refresh uncertainty and fencing while proposing stopped-process, transactional key replacement.
   The transaction-size suitability check and interruption drill are necessary conditions, not promises that rotation is already supported.

## Remaining limits

Numeric defaults, exact transports, selected libraries, and administrative procedures are recommendations rather than accepted requirements.
Custom Tableau OAuth support, embedded browser behavior, provider-specific event/credential semantics, hosting controls, and recovery drills still need evidence.
The full rewritten component contracts and cross-module journeys require a separate integration review.
No application code was executed, no behavioral tests were run, and this review changed no accepted record or canonical specification.
