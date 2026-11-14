# REWRITE-019: One worker path for managed jobs

Current mechanism: [REWRITE-035](REWRITE-035-owned-postgres-job-worker.md) selects the owned Postgres Jobs table and bounded worker.
The selection hold below is historical; the single-worker execution boundary remains accepted.

Status: accepted and locked by the user for the architecture rewrite.
Recorded: 2026-11-08.

## Decision

All managed jobs execute through workers rather than offering both inline and worker execution for the same job interface.
Ordinary authenticated proxy requests execute directly in the API process and return native provider responses.
Authentication, connection management, and HTTP callbacks remain API responsibilities, using shared credential and authorization infrastructure.
Use one API process and one worker initially from the same codebase, with the existing Postgres database holding durable job state.

## Rationale

A single managed-job execution path simplifies supervision, cancellation, testing, and result handling.
There is no established short-job latency requirement that justifies maintaining a second inline job path.
Queueing ordinary proxy requests adds delay and complicates native response, upload, and streaming behavior without serving their request-forwarding purpose.

## External tasks and client behavior

The worker submits external agent tasks, stores their external identifiers, and releases execution capacity while those tasks run elsewhere.
Callbacks or scheduled provider status checks advance job state without a worker being continuously occupied.
Job submission returns a job identifier and completion updates use the accepted event delivery mechanism.
An SDK await convenience may wait for completion without changing the worker execution model.

## Limits and relationships

Worker execution does not imply safe retries, exactly-once effects, or guaranteed completion after interruption.
REWRITE-007 and REWRITE-016 retain author-controlled business retry behavior.
REWRITE-008 retains basic duplicate job submission protection while the job record is retained.
REWRITE-001 remains the durable execution direction; this record excludes an optional inline managed-job variant.
PROPOSAL-004's suggestion of direct managed execution is not adopted as part of the job interface.
Ordinary proxy calls and any internal utility code are not automatically managed jobs.

## Details still to resolve

Select an established job library or justify a smaller existing mechanism against these requirements before implementing custom queue machinery.
Specify worker claims, cancellation, interrupted execution, external observation, retention, and SDK job APIs coherently.
The library, precise claim algorithm, and operational defaults have not been selected.

## Required rewrite consequences

Use distinct proxy and job interfaces across architecture, execution, HTTP/SDK, persistence, and verification.
Remove dual inline/worker managed-job execution and avoid duplicating credential or provider infrastructure in workers.

## Verification boundary

This records the accepted execution model, not implemented or tested queue/worker behavior.
