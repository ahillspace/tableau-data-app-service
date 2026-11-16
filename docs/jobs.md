# Jobs

A Job is durable work that runs in a worker and can outlive the page that started it.
The Jobs component owns admission, the queue, execution, external task waits, callbacks, results and retention.
Requirements come from [product](product.md); shared types are in [contracts](contracts.md).

## Handlers

A Job handler is code registered by a preset under a name.
A handler belongs to a provider type and declares its input schema, whether an attempt may be replayed, any retries for settled failures, and any limits lower than the installation's.
A Data App submits a Job by handler name and the definition it runs against, which must be of the handler's provider type; it cannot submit code.

## Admission

`POST /v1/jobs` takes a handler name, the ID of the definition the Job runs against, input and a submission key chosen by the app.

- The caller's app session must be able to check out that definition at admission time.
- Input larger than the input cap, 100 MB by default, is refused with `input-too-large`.
- The submission key is unique per owner identity and handler.
  A second submission with the same key returns the existing Job if the input matches, and `submission-key-conflict` if it does not.
  Inputs are compared by a SHA-256 hash of their canonical JSON.
- The Job row is committed before the response is sent; a response saying `accepted` always means a committed Job.

## Queue and execution

The Jobs table is the only queue.
Workers claim due Jobs with `FOR UPDATE SKIP LOCKED`, set a lease, and renew it while running.
Each worker runs up to a configured number of Jobs at once.

A handler receives its input, a checkout function for its definition bound to the owner's identity, a progress reporter, and an abort signal.
The Job's owner identity is fixed at admission; the Job runs with that identity's current connection, and fails with `not-connected` if it has been disconnected.

The runtime cap, 24 hours by default, runs from first start and includes waits and retries; nothing resets it.

## External tasks

A handler that starts work elsewhere returns a wait with an external task ID and a callback verifier.
The Job moves to `waiting`, releases its worker slot and stores the task ID.
A verified callback at `/v1/jobs/callbacks/{jobId}` moves it back to `queued` with the callback body as handler input.
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
A handler may implement remote cancel for its external task.

## Results and retention

A result larger than the result cap, 100 MB by default, fails the Job with `result-too-large`.
Results are kept for seven days and finished-Job records for thirty days after the Job finishes, both configurable.
A finished-Job record outlives its result so a repeated submission key still returns the original Job, and a late reader is told `result-expired`.
Workers delete expired results and records in bounded batches.

## Reading Jobs

The owner reads and lists their own Jobs from any Data App.
Reading a result needs a valid app session for the owner, not a usable connection, so results stay readable after disconnect.
Operators can list and cancel any Job.

## Failure and recovery

| Failure | Behavior |
| --- | --- |
| Worker crash | Leases expire; running Jobs become `interrupted` or retry as their handler declares. |
| Database unavailable at admission | Admission fails; no Job is reported as accepted. |
| Callback for an unknown or finished Job | Rejected and logged. |

## Extension

A new handler is code registered by a preset.
