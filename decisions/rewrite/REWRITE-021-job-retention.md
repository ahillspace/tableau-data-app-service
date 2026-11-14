# REWRITE-021: Configurable job and result retention

Status: accepted by the user for the architecture rewrite.
Recorded: 2026-11-08.

## Decision

Default completed-job result-body retention to seven days.
Default basic completed-job record retention to thirty days.
Make both periods operator-configurable and measure them from terminal completion.
Do not remove unfinished jobs merely because a retention period elapsed; retain them until completion or their configured deadline is handled.
Applications needing permanent result storage save results in their own storage.

## Rationale

Result bodies can be large or sensitive, while small job records remain useful for troubleshooting and duplicate submission protection.
Separate retention periods preserve useful history without retaining every payload indefinitely.

## Consequences

After result expiry, return an explicit result-expired response while the basic job record remains available to authorized callers.
Do not rerun a completed job merely because its result body expired.
Keep the submission identity and command comparison material with the basic job record for REWRITE-008's duplicate protection.
After that record is removed, the same submission ID may create a new job as already accepted; do not imply permanent duplicate prevention.
Retain no more original inputs or private metadata than execution, authorized results, and the documented retention policy require.

## Required rewrite consequences

Specify distinct result and job-record expiration in execution, persistence, SDK, and verification contracts.
Make cleanup bounded and deliberate without deleting active work or claiming expired results are recoverable.
These defaults adopt only the job-retention portion of PROPOSAL-004, not its other unaccepted mechanisms.

## Verification boundary

This records accepted retention behavior and defaults, not implemented cleanup or measured storage capacity.
