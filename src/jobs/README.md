# Durable Jobs integration

Jobs is an optional provider entrypoint, separate from ordinary HTTP capabilities.
Slack declares no capabilities and needs no Job declarations.
A trusted provider supplies a `JobDeclaration` alongside the matching registry Job slot.
Its schemas must be representable as JSON Schema; custom refinements, coercion, stripping, overwrites and executable transforms are rejected rather than silently changing validation semantics.
Use explicit strict or loose objects and fixed JSON defaults outside schema alternatives.
Keep executable declarations available while nonterminal Jobs need them.
Retained metadata carries its own immutable comparison schema, so equal submission recovery still works after admission or executable retirement.

Register migration `020_jobs` with the single core migration owner before API or worker readiness.
It exports `up` and `down` without changing the frozen core migration.
`JobsDatabase` extends the core Kysely interface with `jobs` and `job_payloads`.
The separate payload table stores binary AES-GCM ciphertext, nonce, tag, key ID, application byte count and bound payload revision.
The authenticated context is `{kind: 'job-input' | 'job-result' | 'job-task', id: jobId, provider: registrationId, revision}`.
Offline rekey must include this table, authenticate each original context and process one envelope at a time through the shared key custody implementation.
No plaintext maintenance artifact is needed.

Construct one `PayloadProcessor({keyId, keys, workingBytes})` from the same protected key set as core.
`workingBytes` is an explicit physical preparation budget chosen from measurements and available host memory, separate from reserved control headroom.
Admission accounts for actual ingress bytes, comparison, canonicalization, encryption and driver copies; only new Jobs acquire the additional encryption/storage preparation budget.
Result preparation measures actual serialized bytes before reserving encryption working memory, and holds the resulting binary payload reservation through publication.
Authorized result HTTP reads hold their actual-byte reservation through response completion or socket close.
No future saved-result space is reserved at admission.
The focused 100 MB fixture uses a 2.2 GB preparation budget and one execution slot; these are test settings, not a production sizing claim or a universal slot limit.
Trusted handlers must also bound their own allocations and avoid detached work.

Construct `JobsService({core, payloads, declarations, callbackOrigin, limits, onHint?})` in each participating role.
`jobLimitsFromEnvironment` validates the three reducible caps and configurable fixed result/metadata retention.
The environment names are `JOB_INPUT_MAX_BYTES`, `JOB_RESULT_MAX_BYTES`, `JOB_EXECUTION_MAX_SECONDS`, `JOB_RESULT_RETENTION_SECONDS` and `JOB_METADATA_RETENTION_SECONDS`.
Omitted settings preserve 100000000 input/result bytes, 86400 execution seconds, seven result days and thirty metadata days.
Original account, connection generation, limits, deadline and completion retention never move on resubmission or observation.

Register the same Jobs owner with `connections.registerAuthority('job', jobs)` and `connections.registerAuthority('remote-cancel', jobs)`.
The latter is dormant for integrations without a cancel hook and creates no remote cleanup claims for them.
`jobsApi(jobs, {cleanupMs})` returns the API extension for A20-A24 and declared provider callback routes.
It uses the core access/connection ports and never implements a parallel authorization policy.
`jobs.disclose(access, id)` returns only `{id}` or null for Events routing after current authentication.
`onHint(id, revision)` receives a persisted revision after commit, may coalesce transitions, and must remain lossy.
It never wakes the scheduler or changes an accepted response.

Construct `JobsWorker(jobs, options)` with measured execution/I/O slots, lease, heartbeat, scan, cleanup and batch bounds.
Await `worker.start()` so missing active executable versions fail startup visibly.
Lease must exceed three heartbeats, scan interval and cleanup bound.
Its independent control pool scans deadlines, cancellation, expired claims and retention even when execution slots are full.
Read-only observations and conditional remote cancellation use separate bounded I/O slots with alternating opportunities.
Startup, reconnect fallback, earliest due timers and local capacity release discover committed work without Redis.
A worker with no accepting declarations and no retained Jobs stops Job scans.

Run the worker role in a child of the independent `superviseWorker` watchdog.
The child calls `startWorkerHeartbeat` and supplies `requestWorkerTermination` to its lifetimes.
Heartbeat messages prove event-loop responsiveness only; database errors change readiness without becoming loop-hang evidence.
The parent sends TERM, then KILL after its grace, and permits capacity reuse only after the returned `exited` Promise resolves.
The helper never returns reusable capacity for an unsettled handler or failed disposal.
Whole-process termination can interrupt siblings, whose expired initial claims become interrupted with unknown external effects and no replay.
Await `worker.close()` during drain, then close the payload processor and owned DB pools.
A hung close remains subject to the independent supervisor and must not be treated as completed disposal.

Provider callback verification authenticates source/per-task evidence before returning a bounded interpretation.
Prebound correlation is a locator, not a verifier.
The returned account/task must match the original immutable binding, including after provider disconnect.
`payloads.parseJson` is available when a verifier needs asynchronous parsing of a large verified callback body.
An observation must be read-only and must never submit again.
A remote cancel hook receives only the recorded task and a separate fixed cleanup deadline, after the irreversible issued marker commits.
Uncertain issued cancellation is not retried and never proves rollback.
