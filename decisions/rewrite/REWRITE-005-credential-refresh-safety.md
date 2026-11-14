# REWRITE-005: Coordinate refresh and preserve uncertain outcomes

Status: accepted by the user for the architecture rewrite.
Recorded: 2026-11-08.
Audit topic: D05.

## Decision

Centralize credential refresh coordination in the shared credential machinery.
Coordinate concurrent refresh attempts and reread current persisted credentials before dispatching a renewal when necessary.
Fence credential updates so a stale refresh cannot reactivate a disconnected connection or overwrite a replacement authorization or newer credentials.
Persist enough renewal-attempt state to distinguish work known not to have been dispatched from a request that may have reached the provider with an unknown outcome.
Do not treat a timeout or expired worker claim as proof that token rotation did not occur.

## Rationale

A provider may rotate a refresh token before the response is lost.
Blind reuse of the old token may fail or have provider-specific consequences.
Concurrent refresh, disconnect, replacement, and interrupted requests must not corrupt connection authority or silently restore obsolete credentials.
The accepted mechanism makes this uncertainty explicit rather than creating a guarantee of exactly-once renewal.

## Recovery policy

Use provider-documented safe retry or authoritative reconciliation when available.
Expose provider-specific renewal and recovery behavior through narrow hooks within the shared flow accepted in REWRITE-002.
If safe recovery is unavailable, require reconnection rather than pretending the stored credentials are usable.
Do not force reconnection for every transient failure when evidence supports a safe retry.

## Required rewrite consequences

Define renewal ownership, durable attempt state, dispatch boundaries, conditional credential replacement, and recovery after interruption.
Integrate these invariants with asynchronous workers under REWRITE-001; a lost worker lease must not authorize blind redispatch.
Keep coordination and persistence in the core rather than duplicating them in each provider or capability.
Account for connection authorization changes and newer credential revisions when accepting any delayed renewal response.

## Details still to resolve

The architecture owner must specify the minimal state machine, claims, conditional writes, and timeout rules that enforce these invariants.
Establish safe recovery per supported provider instead of assuming uniform refresh-token rotation behavior.
Retain an honest operational path for ambiguous outcomes without claiming unverified provider guarantees.

## Affected specification areas

Update specs/access-connections.md, specs/persistence-operations.md, and specs/contracts.md for renewal coordination and state.
Reconcile worker execution and provider recovery hooks in specs/providers-execution.md and architecture.md.
Update decisions/choices.md and verification.md.

## Acceptance evidence for the rewrite

Trace simultaneous refresh requests, disconnect during renewal, replacement during renewal, and a delayed response after newer credentials are stored.
Trace interruption before dispatch, a response lost after possible remote rotation, and recovery after worker claim expiry.
Show both a provider-supported safe recovery and a provider requiring reconnection.

## Verification boundary

This is accepted design direction, not an implemented or tested credential lifecycle.
Concurrency and provider recovery behavior require implementation verification and provider-specific evidence.
