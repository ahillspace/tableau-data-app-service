# Jobs

A Job is durable work that runs in a worker and can outlive the page that started it.
The Jobs component owns admission, the queue, execution, external task waits, callbacks, results and retention.
Shared types are in [contracts](contracts.md).

## Handlers

A Job handler is code registered under a name unique across the installation.
A handler declares how its input is validated, whether an attempt may be replayed (`retrySafe`), any retries for settled failures, and any limits lower than the installation's.
The catalog supplies no executable handlers; an installation has none until an explicit code extension registers one.
A Data App submits a Job by handler name and the definition it runs against, which must satisfy the handler registration's explicit applicability contract; it cannot submit code.

## Admission

`POST /v1/jobs` takes a handler name, the ID of the definition the Job runs against, input and a submission key chosen by the app.

- The caller's app session must be able to check out that definition at admission time.
- An unknown handler is refused with `handler-not-found`, and an inapplicable definition with `invalid-request`.
- Input larger than the input cap, 100 MiB by default, is refused with `input-too-large`.
- The submission key is printable ASCII of 1 to 200 characters, unique per owner identity and handler.
  A second submission with the same key returns the existing Job if the definition and input match, and `submission-key-conflict` if either differs.
  Inputs are compared by a SHA-256 hash of their canonical JSON.
- A new Job answers 201 and a repeated submission answers 200, both with `{ job, created }`.
  The Job row is committed before the response is sent.

## Queue and execution

The Jobs table is the only queue.
Workers claim due Jobs with `FOR UPDATE SKIP LOCKED`, set a 30-second lease, and renew it every 10 seconds while running.
Each worker runs up to `WORKER_CONCURRENCY` Jobs at once, four by default.

A handler receives its input, the callback body when it resumes (`resume`), the attempt number, a checkout function for its definition bound to the owner's identity, a protocol fetch, a progress reporter, a callback issuer and an abort signal.
The Job's owner identity is fixed at admission; the Job runs with that identity's current connection, and fails with `not-connected` if it has been disconnected.

The runtime cap, 24 hours by default, runs from first start and includes waits and retries; nothing resets it.
Retry backoff is the handler's `backoffSeconds` doubled for each further attempt.

## External tasks

A handler that starts work elsewhere asks for a callback, which returns a URL and a single-use verifier, gives both to the external system, and returns a wait with the external task ID.
The Job moves to `waiting`, releases its worker slot and stores the task ID.
The external system calls `POST /v1/jobs/callbacks/{jobId}` with the verifier as the `Tableau-Service-Authorization` bearer.
A verified callback is answered with 202 and moves the Job back to `queued`, and the handler receives the callback body as `resume`.
A callback that arrives while the Job is still running or queued is kept and takes effect once the wait is recorded.
A waiting Job can also set a time to check status itself.

## States

| State | Meaning |
| --- | --- |
| `queued` | Admitted and due to run. |
| `running` | Claimed by a worker. |
| `waiting` | Waiting on an external task. |
| `succeeded`, `failed`, `cancelled` | Finished. |
| `interrupted` | A worker lost its lease mid-run; the provider may have acted. |

An attempt ends either settled or uncertain.
It is settled when the handler returns: success, a failure it reports, a cancel or a wait.
It is uncertain when the handler throws, when its worker stops or loses its lease mid-run, or when it runs past its deadline, because the provider may have acted on a request whose answer was lost.

- A settled failure is retried only when the handler declares retries, with the backoff and retry count it declares.
- An uncertain attempt is replayed only when the handler declares replay safe (`retrySafe`); otherwise the Job ends `failed` or `interrupted`.
  A thrown failure is replayed when the handler declares both retries and replay safe; an interrupted attempt is replayed when it declares replay safe.
- Once any attempt was uncertain, the Job's `remoteEffectsUnknown` stays true for every ending except `succeeded`, so a later settled attempt never hides an earlier one.
  A remote cancel that the handler confirms clears only the uncertainty of the external task it stopped.

A Job's next state is committed under a lock on its row, and the time, the deadline, the claim and any cancel are read after that lock is held.
At that commit a recorded cancel comes first, then the deadline, then the attempt's own outcome.
An attempt that commits at or after its deadline is not published as a success; it ends `failed` with `runtime-exceeded` and `remoteEffectsUnknown`, and its finish time is the time of that commit.
A failure that commits after its deadline ends as the handler reported it and is not retried.

## Cancellation

Cancelling a queued or waiting Job ends it.
Cancelling a running Job aborts its signal; the Job ends as `cancelled` when the handler returns, and reports whether remote effects are unknown.
A cancel recorded before the attempt's commit wins over whatever the attempt returned: a success is discarded and reports unknown remote effects, and a failure is neither retried nor replayed and keeps its uncertainty.
An attempt stopped by its worker shutting down, or recovered after its lease expired, ends `cancelled` with unknown remote effects when a cancel was recorded before that transition locks its row, rather than being interrupted or replayed.
A handler may implement remote cancel for its external task, which is given 10 seconds.

## Results and retention

A result larger than the result cap, 100 MiB by default, fails the Job with `result-too-large`, and a result that is not JSON fails it with `result-invalid`.
Either is still a success at the commit: a recorded cancel or a passed deadline takes precedence over the rejection, as for any other success.
Results are kept for seven days and finished-Job records for thirty days after the Job finishes, both configurable.
A finished-Job record outlives its result so a repeated submission key still returns the original Job, and a late reader is told `result-expired`.
Workers delete expired results and records in batches of 500 every minute.

## Reading Jobs

The owner reads and lists their own Jobs from any Data App.
Reading a result needs a valid app session for the owner, not a usable connection, so results stay readable after disconnect.
Reading a result of an unfinished Job returns `job-not-finished`, and of a Job that finished without one returns `job-has-no-result`.
Operators can list and cancel any Job.

## Failure and recovery

| Failure | Behavior |
| --- | --- |
| Worker crash | Leases expire; running Jobs become `cancelled` when a cancel was recorded, otherwise `interrupted` or retried as their handler declares. |
| Database unavailable at admission | Admission fails; no Job is reported as accepted. |
| Callback for an unknown or finished Job | `job-callback-invalid` with status 404, logged. |
| Callback with the wrong verifier | `job-callback-invalid` with status 401, logged. |

## Extension

A new handler is a JobHandlerDefinition added through the explicit code extension registry.
