# REWRITE-026: Accepted hardening safeguards

Current scope: [REWRITE-034](REWRITE-034-data-app-and-provider-boundary.md) removes outbound application-server webhooks, their signing keys and receiver retry/replay machinery.
Provider ingress verification, browser audience checks, bounded live delivery and all unrelated safeguards remain accepted.

Status: accepted by the user during the final review walkthrough.
Recorded: 2026-11-09.

## Accepted decisions

- Credential/context handling: classify every reusable authenticator, including auxiliary tokens, as encrypted secret material; use typed references from runtime context and return credentials with their matching account/destination context in one immutable authorized snapshot.
- Refresh safety: retain the already accepted coordination, durable uncertainty and stale-update fencing; a delayed refresh cannot overwrite newer authorization or undo disconnect.
- Native proxy safety: restrict credential-bearing traffic to approved destinations and explicitly reject unsupported requests; never silently substitute an HTTP method.
- Optional event delivery: verify incoming events, exclude sensitive payloads from routine logs, and use an established timestamp/ID/body signing format with distinct backend-subscription keys and receiver replay protection.
- Live delivery: check current audiences before each logical event delivery or webhook attempt, bound pending event counts/bytes, and disconnect slow consumers rather than grow buffers indefinitely.
- Installation/operations: use ordinary migration tooling and prepare schema/dependencies before API traffic or worker claims; stop admission/claims before closing dependencies.

These decisions consolidate the agreed portions of final review topics F03, F04, F05, F08 and F09.
The earlier accepted ownership, encryption, refresh, event-loss and schema-ordering decisions remain in force.

## Scope boundaries

Event signing applies to outbound backend webhooks; browser SSE uses its authenticated service session without a subscriber signing secret in browser code.
Ordinary authenticated proxy request/response traffic does not acquire an event envelope, subscription or webhook-signing requirement.
Audience checks operate at logical delivery boundaries, not per network byte or chunk; already transmitted data cannot be recalled.
No new event archive, replay service or durable delivery queue is accepted.

Acceptance does not select numeric lifetimes, sizes, retry schedules, capacity thresholds, a database locking mechanism or a custom job queue.
It does not accept the proposed exclusion of provider streaming, the memory-only browser-session candidate or its reload behavior.
The signing library and compatible wire details remain implementation choices within the accepted established-format requirement.

## Pending walkthrough and user guidance

Discuss app audiences/session continuity, provider-consent expiry, transport support, job execution implementation and capacity separately.
The user wants a small deployment initially used primarily by them, without a large orchestration layer.
A shared job module is already required; choosing a library or custom implementation remains open, and larger organizational hosting is not a current requirement.
For capacity, the user accepted F07 subject to no capacity limits per app and no unnecessary throttling; protection should address actual whole-service resource exhaustion.
The original acceptance on 2026-11-09 said: "as long as we arent trying to implement capacity limits per app or trying to throttle things unnecessarily Im okay with it."
This is an accepted policy, not a new question for a later walkthrough; numeric ceilings and the concrete admission mechanism still require engineering evidence.
Later per-app/principal proxy and per-owner/app stream-cap proposals do not override that acceptance.

## Evidence boundary

This record establishes user acceptance of the safeguards, not implementation or runtime/security verification.
Earlier review reports and source manifests retain their historical scope.
