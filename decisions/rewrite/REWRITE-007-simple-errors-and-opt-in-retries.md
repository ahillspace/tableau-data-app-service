# REWRITE-007: Simple errors and opt-in retries

Status: accepted by the user for the architecture rewrite.
Recorded: 2026-11-08.
Audit topic: D07.

## Decision

Do not add a mandatory effect-classification, recovery, or reconciliation framework for capability authors.
Default automatic capability retries to off.
Allow trusted backend capability authors to configure retries when appropriate.
Operations return success or an error; capability authors may supply additional outcome information when useful.
The browser SDK must not automatically repeat failed writes.

## Rationale

The user rejected additional safety machinery for this trusted internal platform.
A common mandatory classification system would add complexity and authoring obligations beyond the accepted need.
An error does not prove that a remote action had no effect, and disabling automatic retries does not establish exactly-once execution.
Document these limits without requiring every capability to implement uncertain-effect recovery.

## Required rewrite consequences

Remove mandatory effect evidence and platform-enforced retry-safety classification as general capability requirements.
Do not require stable step keys, dispatch markers, or reconciliation interfaces solely to implement the rejected general effect framework.
Preserve ordinary request/job status, error handling, authorization, and duplicate-submission decisions unless separately changed.
Distinguish a job's local execution status from guarantees about remote side effects.
Document retry configuration and the capability author's responsibility for duplicate effects when retries are enabled.
Keep optional provider-specific outcome details possible without turning them into a required framework.

## Relationship to other decisions

REWRITE-005 remains accepted for credential refresh coordination, stale updates, and uncertain token renewal.
This decision concerns capability execution and does not revoke that credential lifecycle decision.
Reconcile REWRITE-001 worker recovery with retries off by default; reclaiming abandoned work must not silently replay a capability that may already have run.
Reconcile custom clients under REWRITE-006 with the simplified error and retry contract rather than reinstating mandatory effect evidence through that interface.
Command deduplication under D08 remains a separate undecided topic.

## Details still to resolve

The architecture owner must specify job handling after worker interruption without assuming retries are authorized.
Define minimal error and retry configuration contracts and avoid implying a failed operation is safe to repeat.

## Affected specification areas

Update specs/contracts.md, specs/providers-execution.md, architecture.md, decisions/choices.md, and verification.md.
Reconcile job persistence and HTTP/SDK behavior in specs/persistence-operations.md and specs/events-http-sdk.md.

## Verification boundary

This records accepted simplification, not implemented retry behavior or tested failure recovery.

## Proxy-first compatibility clarification, 2026-11-08

The no-automatic-retry default also applies to proxy requests.
Preserve native provider errors where practical instead of requiring a shared effect-classification format.
Any proxy retry option must be explicit rather than silently enabled by the transport.

These clarifications apply REWRITE-010 and do not introduce a separate product decision.
