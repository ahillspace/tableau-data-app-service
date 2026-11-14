# REWRITE-001: Durable asynchronous execution

Status: accepted by the user for the architecture rewrite.
Recorded: 2026-11-06.
Audit topic: D01.

## Decision

Replace the inline-only execution assumption with durable asynchronous jobs.
Use separate API and worker processes within one codebase, sharing provider and authentication infrastructure.
Support both work executed by our workers and jobs delegated to an external provider, including agents that can take a long time to complete.
For externally managed jobs, persist the external task ID and track completion through provider-supported polling or callbacks rather than occupying a worker while waiting.

## User requirement and rationale

The user identified future agent providers with long-running jobs as the concrete reason for this change.
The user was not concerned about restart behavior as the original justification for a separate execution layer.
After discussion of long-running external agents, the user accepted durable asynchronous execution and the distinction between local execution and externally managed jobs.
This is support for calling agent providers, not approval to build an agent runtime or workflow engine.

## Required rewrite consequences

Describe job submission, durable acceptance, status inspection, result retrieval, progress where available, and cancellation requests.
Distinguish external task acceptance from external task completion.
A submitted external task must not require an open browser request or a continuously occupied worker to finish.
Document deadlines, dispatch ownership, interrupted execution, duplicate submissions, and provider-specific retry guarantees across the API and worker boundary.
Preserve explicit uncertain and partial outcomes; background execution does not make remote writes exactly once.
Keep provider authentication, credential renewal, authority checks, and controlled outbound requests shared rather than duplicated in workers.

## Details still to resolve

The job state machine, queue implementation, worker claims, recovery behavior, and scheduling contract require architecture-owner design.
Postgres-backed queuing and a brief wait for short results were proposed, but their precise mechanisms were not separately settled by the user.
Cancellation is a request whose actual effect depends on the provider; define how that distinction is exposed.
Define how authority lifetime and revocation affect queued work, external status checks, and result disclosure.
Do not assume a whole capability handler can safely restart after interruption.

## Affected specification areas

Review GOALS.md and PRD.md for the accepted long-running capability requirement and the distinction from hosting an agent runtime.
Rewrite the execution topology and owner responsibilities in architecture.md.
Update specs/contracts.md, specs/providers-execution.md, specs/events-http-sdk.md, and specs/persistence-operations.md for the job lifecycle.
Update decisions/choices.md and verification.md, replacing inline-only assumptions and adding cross-module job scenarios.

## Acceptance evidence for the rewrite

Trace one lengthy locally executed operation and one externally managed agent job from submission through completion and result disclosure.
Show that browser disconnection does not cancel an accepted job.
Show that waiting on an external task does not reserve an active worker.
Account for lost submission responses, duplicate callbacks, polling failures, revocation, cancellation, and unknown external effects without promising unverified provider guarantees.

## Proxy-first compatibility clarification, 2026-11-08

Durable execution applies to managed jobs, not every provider API request.
Ordinary proxy requests execute directly within bounded HTTP request handling.
Do not wrap every proxy call in a queued job.

These clarifications apply REWRITE-010 and do not introduce a separate product decision.
