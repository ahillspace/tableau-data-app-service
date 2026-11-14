# PROPOSAL-004: A small durable job runner

Status: new architecture recommendation for user review, implementing the direction of REWRITE-001, REWRITE-007, and REWRITE-008.
Recorded: 2026-11-08.

## Recommendation and why

Use Postgres job rows as the queue, with separate API and worker processes from one codebase.
Workers claim eligible rows in short transactions; do not hold a database transaction open while a handler runs.
Postgres explicitly supports `SKIP LOCKED` for queue-like concurrent consumers: [SELECT documentation](https://www.postgresql.org/docs/current/sql-select.html).
A broker or workflow engine is unnecessary for the accepted internal-service workload.
The job owner supplies admission, status, deadlines, cancellation requests, result retention, and worker supervision; it does not supply exactly-once external effects.

Ordinary proxy calls remain direct requests.
A managed capability may offer direct bounded execution, a durable job, or both through the same authorization and credential interfaces.
Durable admission always returns a job handle with HTTP 202; the SDK can await completion using SSE and one authorized result read instead of introducing a special blocking submission mode.

## Admission and retained history

Use a random UUID submission ID generated once by the SDK and retained with the intended command.
Atomically insert a unique `(app, authenticated owner, submission ID)` job and an immutable digest of capability/version, execution-relevant validated input, selected provider binding, and caller connection selection.
Canonical comparison sorts object keys, preserves array order, rejects non-JSON input, and uses the same bounded/defaulted input that execution receives.
Use a maintained canonicalization implementation or a constrained project representation selected during implementation; raw JSON text equality is insufficient.

An identical repeat returns the existing job after current disclosure authorization; changed command content returns conflict.
The row stores the originally resolved connection, identity mode, epoch, and capability/configuration references.
A duplicate never selects a newly configured connection or retargets a job after account replacement.
Persist the input needed for asynchronous execution under the same confidentiality protections as results, then discard it when no longer needed.

Recommend terminal job metadata/digests for thirty days and bounded outputs for seven days, both measured from terminal completion and reported to callers.
Do not delete nonterminal jobs to meet retention limits; terminate overdue tracking explicitly first.
Output expiry leaves the same job record and duplicate protection until metadata expiry.
After record deletion, the same submission ID can create new work, exactly as REWRITE-008 permits.
Lookup absence, lost local SDK state, or restore history loss does not prove that the operation never ran.
The SDK does not automatically recreate work after missing history or fresh authentication; no command windows or separate tombstone service are introduced.

## State and interruption

| State | Meaning and next action |
| --- | --- |
| `queued` | Durably accepted; a worker may start it if current authority and its deadline allow. |
| `running` | A worker has atomically claimed one attempt before invoking the handler. |
| `waiting-external` | External task identity is durable; a due status check or verified callback may advance it without occupying a worker between checks. |
| `succeeded` | A bounded validated result is durable. |
| `failed` | Execution or tracking ended with a safe error code; remote effects may already exist. |
| `cancelled` | Local work stopped before start, or the handler/provider confirmed cancellation; the response states which. |

Keep `cancelRequestedAt`, attempt count, current claim token, lease expiry, and safe error details as fields rather than multiplying public states.
Recommend a thirty-second lease with ten-second heartbeats as starting supervision values, independently configurable from a job's overall deadline.
Only a matching claim can heartbeat or commit a result; a stale worker cannot overwrite a newer terminal state.
Losing the lease tells a cooperative handler to stop and prevents additional shared-helper dispatches.
It cannot undo a provider request already sent or forcibly stop uncooperative custom SDK code.

An expired `running` attempt becomes `failed/interrupted` by default.
Do not requeue it just because the process might have crashed before the first useful action.
This deliberately conservative job-level start boundary replaces the rejected mandatory step/effect framework.
There are no required per-operation dispatch markers, step keys, or outcome taxonomies for capability authors.
Credential renewal retains its separate REWRITE-005 dispatch evidence.

## Retries and cancellation

Default handler retries to off, including retry libraries inside custom clients.
An author can opt into a bounded retry count, delay/backoff, and selected returned error categories, accepting that rerunning a whole handler may repeat earlier effects.
The default opt-in retry policy still does not replay an abandoned running attempt.
If interrupted-attempt replay is ever enabled for a specific capability, require explicit author intent and proof the old worker is terminated/fenced before starting another attempt; lease expiry alone is insufficient.
Do not add that exceptional replay mechanism to the initial implementation without a concrete capability that needs it.

The SDK never automatically repeats a failed business operation under a new submission ID.
Browser disconnection leaves an accepted job running.
An explicit cancellation request is durable and idempotent: cancel queued work immediately, signal running work, and invoke an optional provider cancel operation for known external tasks when current authority permits.
If a completion wins the race, report the actual completion; do not overwrite it as cancelled.
If provider cancellation is unavailable or unknown, report the cancellation request and continue permitted observation until completion or deadline.
An error, timeout, or local cancellation does not assert that the provider had no effect.

## Externally managed work

A capability's start handler can return either a final result or a bounded external-task descriptor containing provider task ID and the registered status/cancel behavior to use.
Persist that descriptor and `waiting-external` atomically; release the worker immediately afterwards.
The common worker schedules due provider status checks with backoff and jitter, while a verified callback can apply the same monotonic transition.
Duplicate or out-of-order callbacks cannot regress a terminal result.
Observation retries are separate from business-operation retries and are allowed only for the documented status read, never by rerunning task submission.

After process restart, a durable external task ID permits observation to resume under current authority.
If provider acceptance occurred but the external ID was never committed, report an interrupted start with possible remote work.
An optional provider lookup by a native client reference may recover it; no universal reconciliation interface is required.
For a callback arriving before the ID is durable, retain the verified event and use provider-supported correlation or a later status read; do not match arbitrary callback-supplied owners.
If the provider offers neither a reliable status read nor a callback correlation strategy, that external-task mode remains unsupported.

## Authority and deadlines

An admitted job holds a bounded authorization to do that work for its original owner/app/connection, independent of the initiating tab's session expiry.
Before starting, each helper dispatch, and each status/cancel request, recheck current app permission, owner binding, connection state/epoch, and job deadline.
Result disclosure checks current authority and retention independently; an elapsed execution deadline does not expire an otherwise authorized retained result.
Account replacement, disconnect, or grant revocation prevents future work; the job does not silently use a replacement connection.
Expired browser sessions prevent browser disclosure until fresh authentication but do not themselves revoke the admitted job.

Revocation may leave a remote task running because the service no longer has permission to contact it.
End local tracking with an authority-revoked error and retain safe task metadata for authorized operator investigation.
Do not preserve old credentials solely to keep observing or cancelling after revocation.
An authenticated callback may record a minimal terminal fact if its source/job correlation is still valid, but cannot restore authority or disclose result payloads after revocation.

Recommend initial overall deadlines of fifteen minutes for a local handler and twenty-four hours for external-task tracking, configurable per capability within operator maxima.
At deadline, stop local execution/observation and report deadline exceeded; a remote task may continue.
Long CPU-bound workloads and resumable multi-step workflows are outside this runner's initial contract.

## Costs, specification implications, and completion evidence

Automatically rerunning every expired lease is simpler for availability but conflicts with retries off and can duplicate external effects.
A full workflow engine could resume individual steps, but adds the authoring model the user rejected.
This runner accepts more interrupted jobs in exchange for a small, explicit contract.

Replace inline receipts, command windows, mandatory effect evidence, and universal pagination in contracts/execution/HTTP/persistence with job admission, the states above, and capability-defined input/output.
Keep simple success/error responses and optional provider-specific outcome details.
Test concurrent equal/conflicting admission with real Postgres, crashes before/after handler invocation, lease loss with a still-live worker, lost external ID persistence, callback/poll races, cancellation/completion races, revocation, result expiry, and restore.
Demonstrate that a lengthy external task occupies no worker while waiting and that no default interruption path repeats its start operation.
