# REWRITE-035: Owned Postgres Jobs table and worker

Status: explicitly accepted and locked by the user.
Recorded: 2026-11-10.

## Decision

Use our owned Jobs table in Postgres as the sole durable job queue, with a small bounded worker in the same strict TypeScript codebase as the API.
Do not add a separate queue library or workflow platform.
The user selected this design after hearing the owned-worker recommendation, the viable pg-boss alternative and the limits of the source-based comparison.
The user's tie-break preference is to build the small owned mechanism when the maintenance tradeoff is close.
This is a settled implementation choice, not a preferred candidate awaiting another selection exercise.

## Ownership and behavior

Jobs owns atomic admission/deduplication, start authority, execution and observation claims, external task identity, terminal outcomes and retention.
Use short Postgres transactions, conditional revision/claim updates and bounded polling/capacity within the existing worker.
No transaction spans provider network I/O.
Interrupted started work is not automatically queued again; known external tasks are observed without resubmission and waiting releases execution capacity.
Preserve author-controlled retries, verified callback races, explicit cancellation requests and separate result/metadata retention.
Preserve Data App initiation and the already accepted continuation authority after browser/session or connector-reauthorization expiry.
The service now owns the correctness and operational maintenance of these mechanics.

## Planning consequences

D02 is closed as an accepted design decision.
Remove the library-selection gate and mandatory comparative spike from the build plan; do not build two production queue paths.
Real Postgres admission, crash, race, deadline, continuation, shutdown and retention checks verify the selected implementation rather than choosing an engine later.
Queue DDL, indexes and numeric tuning are engineering work under the owned design, not a deferred product decision.
A future change would require material new evidence and an explicit design amendment; it is not scheduled follow-up selection work.

## Evidence boundary

The independent review inspected official documentation and upstream source and recommended the owned mechanism for this bounded contract.
It did not execute a runtime comparison or measure a total code-size advantage.
User acceptance settles the choice despite that evidence limit; it does not establish runtime correctness.
This decision authorizes design reconciliation only, not application implementation, installation or deployment.
