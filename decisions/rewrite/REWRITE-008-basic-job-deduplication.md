# REWRITE-008: Basic duplicate job submission protection

Status: accepted by the user for the architecture rewrite.
Recorded: 2026-11-08.
Audit topic: D08.

## Decision

Keep basic duplicate-submission protection as part of durable job admission.
The browser SDK generates a submission ID for a new logical submission and preserves it when repeating that submission.
Store the submission ID on the job and scope uniqueness to the configured app and authenticated owner.
An identical resubmission returns the existing job rather than starting another.
Reject reuse of the same submission ID with different input.
Duplicate protection lasts while the corresponding job record is retained.
Remove signed submission windows, a separate deduplication history system, and indefinite duplicate-prevention guarantees.

## Rationale

If job admission succeeds but its response is lost, repeating the submission should recover the existing job identifier rather than launch another potentially expensive agent task.
This requires no provider or capability author implementation.
Keep the mechanism proportional to existing durable job storage.
The user considered dropping this protection, then accepted the simplified design after reconsidering its value for long-running jobs.

## Required rewrite consequences

Implement atomic admission using a database uniqueness constraint and input-matching logic, including concurrent equal submissions.
Define the request identity to cover the selected capability and version and the execution-relevant caller input and connection selection.
Use a defined input comparison rather than raw JSON property order.
Return an existing job only after verifying current disclosure authority.
Document job retention and the fact that an old submission ID can create a new job after its record is removed.
Do not silently discard a still-needed job record merely to expire duplicate protection.
An intentional new submission uses a new ID and may perform the operation again.

## Limits and relationship to other decisions

This prevents duplicate local job creation within retained history.
It does not establish exactly-once external effects or prevent deliberate new submissions.
It does not authorize automatic provider retries or replay after worker interruption.
REWRITE-007 keeps automatic capability retries off by default.
Worker claims and interruption handling remain architecture-owner responsibilities under REWRITE-001.
Do not reintroduce signed admission windows or a separate tombstone protocol through those contracts.

## Details still to resolve

Specify submission-ID format, bounded input matching, job retention, and the exact duplicate response contract.
Define interrupted admission and concurrent inserts through the job transaction.
No retention duration has been selected.

## Affected specification areas

Update architecture.md, specs/contracts.md, specs/providers-execution.md, specs/events-http-sdk.md, and specs/persistence-operations.md.
Replace command-window assumptions in decisions/choices.md and verification.md and remove obsolete dependencies from related contracts.

## Acceptance evidence for the rewrite

Trace a lost admission response followed by an equal submission, concurrent equal submissions, and a conflicting submission under the same ID.
Verify that other apps or owners cannot retrieve a job through a matching ID.
State behavior after job-record deletion and distinguish submission repetition from operation replay.

## Verification boundary

This records accepted direction, not implemented or tested job admission.

## Proxy-first compatibility clarification, 2026-11-08

Submission-ID deduplication applies to managed job admission only.
Ordinary proxy calls do not acquire universal deduplication; native provider idempotency parameters may pass through when supported.

These clarifications apply REWRITE-010 and do not introduce a separate product decision.
