# REWRITE-022: Simple live event forwarding

Current scope: [REWRITE-034](REWRITE-034-data-app-and-provider-boundary.md) removes separate application-server webhook delivery and its retries.
Browser SSE, explicit possible loss and no archive/replay remain; the original broader delivery text below is historical.

Status: accepted by the user for the architecture rewrite.
Recorded: 2026-11-08.

## Decision

Use simple asynchronous event forwarding with a small configurable delivery retry count.
Deliver live notifications to browser consumers through SSE and signed webhooks to configured backend consumers as accepted in REWRITE-011.
Do not build a general retained raw-event archive, browser replay system, or multi-day durable webhook delivery queue.
Reject the previously proposed seven-day raw-event retention and twenty-four-hour webhook retry window.
On browser reconnect, applications fetch current provider state where available rather than replaying an event history.
Job completion remains inspectable through retained job records under REWRITE-021.

## Rationale

The user explicitly wants a simple proxy that optionally does more.
Raw event retention and replay added storage and recovery machinery without an established requirement.
The reference investigation found simple forwarding and short retries rather than evidence supporting the proposed multi-day delivery contract.
Keep that research outside product specifications.

## Limits

A disconnected browser or unavailable webhook receiver may miss notifications after delivery attempts end.
Provider APIs may not support reconstructing every missed event from current state; document that limitation for the integration.
Do not promise exactly-once delivery, strict ordering, complete event history, or recovery of every notification.
Small delivery retries resend a notification, not the underlying provider operation, and do not change REWRITE-016's caller-controlled business retries.
No specific retry count or delay has been accepted; choose a small documented configurable default during implementation.

## Relationship to prior decisions and proposals

Preserve REWRITE-011's transport, authorization, and native payload direction while replacing any assumption of durable replay with this live-forwarding scope.
PROPOSAL-005's event archive, replay cursor/namespace/counter machinery, and long-lived delivery rows are not adopted.
The older GOALS acceptance scenario requiring missed-event resync must be rewritten as current-state refresh where supported, with explicit possible loss.
Do not conflate raw-event retention with the separately accepted job and result retention periods.
A real integration needing stronger delivery can justify a specific addition later; do not build that platform now.

## Required rewrite consequences

Remove universal event history, replay cursor signing or encoding, event replay counters, replay namespaces, and history-recovery contracts.
Keep provider receipt/verification/routing, current consumer authorization, bounded live fanout, signed delivery, and small delivery retries.
State the loss boundary plainly and use the smallest operational mechanism for live forwarding.
Do not require a generic event synchronization engine or authoritative-state capability wrapper.

## Verification boundary

This records accepted simplification, not tested provider event forwarding or SSE delivery.
