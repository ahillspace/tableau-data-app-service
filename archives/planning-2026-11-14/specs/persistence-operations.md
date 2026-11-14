# Persistence and operations

Status: integrated storage/coordination and operational contracts; no schema, command or deployment is implemented.
One Postgres database is authoritative through owner-specific Kysely adapters.
Physical names and ordinary indexes may be selected during implementation, but ownership, constraints and conditional outcomes below are required.

## State ownership

| Record family | Owner | Required fields/constraints |
| --- | --- | --- |
| Deployments/sites | Access | Immutable deployment ID and Cloud/Server adapter/configured URL attributes; unique deployment/site ID, enabled state and safe change attribution. |
| Owners/sessions | Access | Unique verified deployment/site/subject; session verifier/revocation, verified authentication time and fixed maximum expiry. |
| App/provider configuration | Access/Providers | Config/defaults/attribution, enabled registration and compatibility revision; no feature permission or personal app-use tables. |
| Operator shared audience | Access/Connections | Explicit verified sites and optional stable users, owned by a lockable connection/source parent; absence denies. |
| Connections/bundles | Connections/Credentials | Immutable owner/provider, state, authority generation, credential generation, explicit reauth time, coherent encrypted credentials/context and safe metadata. |
| Setup transactions | Connections/Access | Initiating owner/session or operator, app attribution, proof/state verifiers, expiry, replacement intent, reference to the shared Credentials mutation for existing connections, single-use callback/browser correlation and terminal status; no duplicate processor or bundle-revision authority. |
| Credential mutation reservation | Credentials | For setup/import/renewal requiring provider interaction, unique connection owner: mutation ID, operation reference/kind, immutable expected authority/credential pair, absolute expiry, dispatch/possible-invalidation phase, active processor or explicit browser wait, uncertainty barrier and bounded recovery/independence evidence. |
| Job metadata | Jobs | Unique app/owner/submission key, immutable command/version/digest/account, effective limits, state/revision, first start/deadline, claim token/incarnation/kind/lease, due time, cancellation and immutable completion/expiry. |
| Job payloads/task context | Jobs | Separately encrypted immutable input/result/task data referenced by job metadata; explicit serialized-byte lengths and payload revision. |
| Callback/cancel metadata | Jobs | For supported hooks only: prebound correlation/source verifier reference and provider/account/task binding; separate bounded remote-cleanup claim, deadline, issued marker and evidence status. |
| Event sources | Events | Verified source/account, setup owner, audience parent, connection generation where applicable, revision/state, provider-declared renewal/health and event-validity times where applicable, protected verifier and fenced maintenance claim/phase. |

Keep large encrypted payloads separate from indexed queue metadata so scans/locks never materialize bodies.
Use constraints for stable owner identity, unique submission keys, one mutation reservation per connection across setup/import/renewal, provider/account-scoped task/correlation identity.
The connection row protects mutation creation/absence; prefer connection-owned mutation fields, with setup correlation referencing their mutation ID.
Renewal is a mutation kind, not a second attempt record/state machine; the processor token/incarnation/lease, exact pair and dispatch phase have one owner/representation.
New-connection setup with provider interaction uses the same Credentials mutation shape attached to the setup transaction until atomic connection creation.
Strictly local import prepares outside locks and uses the same writer for a single atomic publication with current authority, exact expected generations and no competing reservation or uncertainty barrier; it persists no processor/lease/recovery lifecycle.
Setup terminal status and credential usability are distinct: failing a possibly invalidating setup must retain its exact-revision uncertainty barrier.
Terminal completion and execution identity are immutable; remote cleanup status cannot change them.
There are no temporary event payload rows, raw-event archives, outboxes, replay positions, dedup tombstones, global authority guard or generic business dispatch receipts.
Optional source dedupe and sensitive pagination state exist only for a concrete integration and do not become shared mandatory storage.

## Ordinary request snapshots

M01-M03 define authorization, selection and credential predicates; M09 composes them into one server-internal read projection reused by M05 and M08.
For A18 with an already usable bundle, one coherent read statement joins the bearer/session, enabled site/app/provider revision, selected connection/explicit audience, mutation usability and matching encrypted credentials/context.
No-credential mode omits the connection/bundle join.
Absence denies; safe automatic selection must detect ambiguity in that same projection rather than selecting an unrelated default later.
This path performs zero logical writes: no Job, receipt, last-seen update, usage counter, request-log row or policy shared-lock checkout commit.
The statement snapshot is its local authorization boundary: revocation committed before it denies, while an already-authorized overlapping request may finish.
It does not serialize every reader with policy mutations or promise recall of released credentials/bytes.

Bound statement and preparation duration, carry fixed expiries and check them again immediately before use; do not dispatch expired authority after slow preparation.
Decrypt outside database transactions and retain the coherent bundle only for that authorized operation.
Reuse the request-scoped result through module handoffs rather than independently authenticating, selecting and fetching it again.
A39 uses the same predicates and may consume its snapshot for its first immediate helper operation; each later provider operation checks fresh authority for the bound connection.
No snapshot can authorize another request, later business step, or stale shared audience after a queued wait.
Refresh/mutations and background Job/source checkout retain their explicit conditional transaction contracts; this optimization does not weaken final saved-result disclosure.

Keep immutable schemas/protocol definitions and revision-keyed endpoint/configuration metadata in process memory.
The read must still validate current mutable enablement/revision/session/audience; unknown revisions fail explicitly rather than silently falling back to cached permissions.
Prefetch safe display/readiness fields together without per-row queries, unrelated bodies or all connection secrets.
Fixed-host providers need no discovery; credential-bearing context always travels with its bundle revision.
Cross-request credential caches and per-owner Redis routing remain deferred until measured need.

## Database interaction discipline

These are design targets for logical work, not measured SQL/BEGIN/COMMIT counts or a latency claim.
Use returned state from required writes, joined safe projections and bounded batches before adding a cache or coordinator.

| Path | Concrete consolidation and retained boundary |
| --- | --- |
| Login/handoff | Retain create, launch, callback claim, verified session publication and redemption durability; fold current checks and returned safe state into each required transaction rather than fetching again for the response. |
| A07 restore | Combine current session/site checks with required proof consumption or bearer issuance where the proven transport permits; no last-seen write or expiry extension. |
| A08-A10/A12/A19 discovery/status | Join current authority and safe visible projection in one read per request, without secrets, writes or per-connection queries. |
| A18/native streams | One coherent usable-bundle read; no per-chunk/poll/heartbeat database writes or body persistence. A37 transport remains unproven. |
| A39 capability | Share entry authorization and first immediate helper snapshot; recheck each subsequent provider operation without a Job/receipt/result write. |
| Strictly local import | Prepare/validate/encrypt outside locks; one short writer transaction rechecks current authority/fixed expiry, exact expected bundle pair and no competing reservation or uncertainty barrier, then publishes the full bundle and returns safe state. Stale/conflicting candidates are not rebased or replayed. |
| Credential renewal | Combine reserve/claim and dispatch marker when preparation is complete against the expected revision; publish separately after external work, returning the new coherent bundle under current authority checks. Conflicts/recovery require their actual additional work. |
| Event fanout | Read current ingress mapping once; batch immediately deliverable recipients per interested replica under one current read, with no wait between authorization and logical enqueue/delivery. Queued recipients get a fresh delivery read. No event-body writes. |
| Job admission | Authorized existing-key lookup with safe authority projection, then one atomic new-admission transaction with current recheck; conflicts use existing-row recovery. |
| Job reads | Join authorized metadata/reference/retention and encrypted body only after byte capacity is reserved; split metadata/body when needed for admission. Decrypt outside locks, then retain the final disclosure transaction. Lists never load bodies. |
| Job claim/settle | Bounded candidate batch then conditional claim batch returning needed metadata; fuse immediate first checkout only when its use is known. One conditional attachment/settlement operation, with no follow-up fetch merely to form its response. |
| Background maintenance | Batch live-token heartbeats and indexed due deletion without decrypting bodies; combine due progress with renewal where predicates agree. No heartbeat for an external wait without a live observer claim. |

Use earliest-due timers, bounded fallback scans and startup/reconnect catch-up for applicable maintenance, not tight empty polling.
External observations follow persisted nextCheckAt or supported callbacks rather than querying providers on every database scan.
Never preclaim beyond available capacity, defer promised progress or weaken live predicates just to reduce writes.
Measure real query/transaction/lock duration and round trips by path at implementation time before claiming savings.

## Transactions, concurrency, and failure

Use short named READ COMMITTED transactions with explicit scoped locks for mutations, background checkout and final saved-result disclosure, and parameterized read statements for ordinary snapshots.
No process mutex or Redis primitive supplies correctness across API/worker replicas.
The common order is relevant site rows, provider registration, app configuration when consulted, interactive session where required, connection/audience parent, credential mutation, setup/source state, then job; sort peer IDs within each family.
Source audience membership is protected by its source parent at the source-state position; connection audience membership is protected by its connection parent.
Acquire only the rows actually needed, in the strongest required mode initially, and roll back/reacquire if an earlier-family lock is discovered late.
Use `FOR SHARE` for unchanged authority and `FOR UPDATE` for mutations, not `FOR KEY SHARE`, which does not exclude ordinary non-key updates ([Postgres row locks](https://www.postgresql.org/docs/current/explicit-locking.html)).
All child audience insertion/deletion locks its parent exclusively; transactional readers lock that parent before testing membership, including an absent child row.
Ordinary snapshot readers evaluate membership coherently without a parent lock and accept the documented overlap boundary.
Required absent authority rows deny; a missing site/configuration lookup cannot be turned into implicit permission.
Creation races use unique constraints and a defined parent where needed, rather than attempting to lock a nonexistent child.

Bound pool acquisition, lock wait, statement time and transaction duration.
Release connections between bounded contention retries; only undispatched local database work may retry after rollback, never an already-sent business request or uncertain credential rotation.
No network call, discovery, large validation/canonicalization, encryption, payload decoding or stream drain occurs while authority locks are held.
Unchanged authority readers can proceed together and unrelated connections do not serialize globally.
Candidate queue IDs are hints; acquire authority first, then `FOR UPDATE SKIP LOCKED` and recheck the job, using skip-locked for contention rather than permission.

| Boundary | Locks and conditional contract |
| --- | --- |
| Ordinary interactive checkout | Coherent read-only statement checks current site/provider/app/session/selection/audience/freshness and matching usable bundle; no policy locks or write/commit boundary on usable A18. |
| Job/source checkout | Applicable current site/provider/config/connection/source/job rows, original account generation, live operation claim and the same bundle-usability barrier check; no expired browser-session dependency. |
| Disconnect/replacement | Relevant authority parents then exclusive connection/attempt/source rows; advance authority generation when required, fence credential/setup publication and remove/replace usable bundle without waiting for jobs. |
| Admission | Current disclosure lookup first; for new work, current authority/freshness and connection locks plus atomic unique metadata/encrypted-input commit. |
| Start/observation claim | Candidate scope hints then ordered current authority and job lock; recheck state/due/cancel/generation, set live claim and first-start deadline only if absent. |
| Strictly local import publication | Ordered current authority and exclusive connection lock, exact server-captured expected pair and no competing reservation/uncertainty barrier; publish complete bundle/next generation and applicable reauth/continuity state atomically. First import creates the connection/bundle atomically. No persistent processor claim or external work. |
| Setup/import/renewal reservation and dispatch with provider interaction | Exclusive connection/mutation then associated setup state where present; immutable expected bundle pair, current mutation owner, live operation/processor token/incarnation/lease and fresh expiry. Commit may-have-dispatched and possible old-bundle invalidation before external work. |
| Source dispatch | Ordered authority plus exclusive owned source attempt; exact token/incarnation/revisions/live lease, then durable may-have-dispatched before external I/O. |
| Reserved credential publication | Valid current authority, exact mutation owner/expected bundle pair, live mutation processor token/incarnation/lease/expiry and setup authority where applicable and validated discovery. Atomically publish full bundle/next credential generation and attempt success, then release only that reservation; otherwise explicit stale result. |
| Mutation interruption recovery | Connection/reservation/attempt in the same order. Fence the expired/cancelled processor, then release proven-undispatched/noninvalidating work or retain an uncertainty barrier only for the matching expected pair; preserve proven newer independent bundles and other reservations. |
| Original outcome/progress/task publication | Exclusive job with original immutable identity, expected state/revision and live claim/incarnation/lease/deadline; no requirement that provider connection remain usable for an outcome needing no new call. |
| Verified callback | Verify outside locks, then job lock with original provider/account/task or prebound correlation, allowed state and fresh deadline; fence superseded claimant. |
| Private payload disclosure | Shared current session/site/audience plus job reference/retention check; load/decrypt outside locks, then repeat current disclosure/reference/retention check before logical release. |
| Terminal remote cancellation | Current authority/connection plus job, separate live cleanup claim/deadline and original task/account; commit issued marker before send and only update bounded cleanup evidence afterward. |

Every advancing write explicitly predicates on expected state/revision, random token, incarnation and live lease where applicable.
Read fresh database wall time after lock waits and at the final conditional authorization/mutation boundary; deadline/lease equality is expired.
Use `clock_timestamp()` or equivalent current wall time, not transaction-start `now()`/CURRENT_TIMESTAMP ([Postgres time semantics](https://www.postgresql.org/docs/current/functions-datetime.html)).
A zero-row update is an explicit stale/conflict outcome and is never reported as success.
Claim token and process incarnation jointly fence overlap/replacement, while generations fence changed connection identity/material.

The ordinary read snapshot or the background checkout commit is the respective local authorization boundary; disconnect cannot retract a released snapshot or guarantee no later remote send.
Every subsequent operation reauthorizes, but no transaction atomically commits with an external provider.
Credential revocation and execution/result authority are intentionally distinct: disconnect fences renewal/future checkout while preserving eligible original results and saved history.
At/after execution deadline, reject advancing nonterminal work or settle timeout; already-terminal outcomes remain unchanged.
The narrowly defined late task-ID cleanup recording in [Jobs](providers-execution.md#cancellation-and-terminal-races) uses retained original binding solely for cleanup metadata and cannot accept a late result.

## Resource admission and large payloads

Reserve measured memory/CPU/byte/socket capacity before accumulating large request/result bodies, independently from authority locks.
Authorize private saved-payload reads before loading, and recheck their disclosure after large preparation.
Ordinary native/capability responses use their request authorization boundary; do not add a Job-style final disclosure transaction or body archive.
Account simultaneously live HTTP buffers, UTF-8/decoded strings, validation/canonicalization objects, encrypted buffers, crypto/driver copies and authenticated plaintext.
Near-cap JSON may block the event loop even with asynchronous surrounding I/O ([Node event-loop guidance](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)).
Ordinary stream backpressure does not solve that cost; measure the full admitted 100000000-byte Job path rather than silently reducing its allowance.
Ordinary capabilities use measured request/response preparation budgets, without canonical command hashing, payload encryption or a Job-sized buffer allocation merely because their function is named.
Use maintained schema/canonicalization/AEAD primitives, release copies promptly and process at most one large envelope at a time within maintenance byte budgets.
Add offload/chunking only if measurements demonstrate a need, without inventing an object store or custom cryptographic protocol.

Physical admission/backpressure protects actual allocatable resources, not app/user/IP entitlements, pending-job count quotas or future-result reservations.
Waiting external jobs occupy durable metadata, not execution slots.
Equal retained admission recovery needs bounded validation/disclosure resources but bypasses new-job selection/allocation policy.
Report allocation, disk/database/key or commit failures honestly; inability to persist even a failure is possible and must not become a false durable-success response.
Metrics include RSS, event-loop delay, pending bytes, socket/pool waits, control latency, oldest due work and disk/retention growth without raw bodies.

Budget database connections across all API replicas, worker execution and reserved control pools, commands/maintenance, monitoring and deployment overlap, leaving database headroom.
The sum of per-process maxima, not a copied per-process default, must fit the approved deployment budget.
Reserve control connections and scheduling for deadlines/cancel/expired claims even when payload/execution work is saturated.
Redis publisher/subscriber connections and buffers are separately budgeted when enabled.
No host, traffic, SLA, price or fixed execution-slot count is selected by this specification.

## Data retention and observability

[Jobs](providers-execution.md#results-and-retention) owns seven-day result/thirty-day terminal metadata defaults and immutable expiry.
Validate finite nonnegative retention with metadata at least as long as result retention; unfinished work is never age-deleted.
Delete expired bodies without decrypting them and remove private inputs after terminal settlement when no longer needed.
Use indexed metadata/ID scans, byte/time-aware short batches and earliest-due scheduling plus bounded recovery scans, not whole-payload batches.
Core recovery covers expired sessions/handoffs and shared credential mutations independently of handler slots.
Job recovery/cancel/deadline/retention runs only while a configured enabled Job entrypoint accepts submissions or unfinished/retained rows remain; source maintenance only for configured hooks.
These maintenance hooks do not create Jobs for themselves.
Existing-connection setup/import recovery follows the same exact-revision dispatch-uncertainty contract as renewal, even when the setup is already failed/cancelled/expired; no late scan may poison a newer independent bundle.
Uncertain rotating credentials and mutating source hooks follow their owning recovery rules, never blind lease-based repetition.

Logs contain safe request/app/owner references, revisions, timings, status and service error categories under operator access controls.
Do not log tokens, raw request/response/event bodies, callback/state/code URLs, secret context or private external account identifiers.
Record minimal authoritative registry change attribution atomically with the mutation; operational logs are separate and cannot falsely certify a failed database commit.
Alert on sustained resource exhaustion, core maintenance lag, applicable oldest due Job/source work, worker responsiveness loss, uncertain mutation/source state, schema/key failure and live event loss.
Native/capability monitoring uses safe HTTP status, latency, bytes and abort/error metrics, without fabricated Job success, queue delay or retained-result metrics for ordinary requests.
No analytics or audit platform is introduced.

## Schema setup and process ordering

Use Kysely's existing migrator through one operator-run `db:migrate` command with checked-in migration sources and explicit returned-error/result handling.
API/worker boot never independently migrates; one migration owner serializes install/upgrades before compatible code uses the schema.
Each build declares compatible schema and installed HTTP capability contracts; Job/observer compatibility gates apply to enabled or outstanding durable work.
Refuse the affected readiness/claims when required contracts are missing; a provider without Job handlers does not fail core readiness.
Ordinary HTTP code/configuration needs in-flight drain compatibility, not preservation for the Job retention lifetime.
Compatible replica overlap is allowed only when both builds preserve active-job and credential contracts; otherwise use accepted downtime.
Migration failure is nonzero/unready, not success merely because no exception was thrown.
Incompatible changes stop all API/worker writers, callbacks and automatic replacement before migration; an old process cannot restart into an incompatible schema.

Each process has a fresh incarnation, with no global singleton ownership row.
Startup validates required configuration, schema, keys and database access, then runs bounded recovery/catch-up before normal claims.
API liveness reports event-loop responsiveness, while core readiness reports its required database/schema/key/config dependencies without provider network calls.
Event readiness additionally requires the Redis subscription and valid delivery configuration when enabled, and remains separate from core readiness.
Worker dependency readiness, claim-loop/control health and process responsiveness are distinct signals.
A Postgres outage stops authoritative work but must not be mistaken for an event-loop hang; a dead worker can leave auth/proxy/capability requests available with honest core-maintenance and applicable Job/source-delay health.
Request checks reject expired sessions/claims even before cleanup runs; missing maintenance cannot extend authority.

Shutdown marks unready, stops new API admission/worker claims, closes live streams and drains/aborts admitted resources within the configured host grace.
No claim is considered safely replayable because shutdown was requested.
Lease loss fences further cooperative checkout/publication; conservative persisted recovery handles forced death and unresolved rotation.
The host supervisor monitors responsiveness independently of the Node event loop and enforces a bounded termination sequence for a blocked worker.
Attempt cleanup deadlines detect uncooperative Promises even while process heartbeats continue; the worker stops claiming and requests termination.
Confirm the old process has exited before its physical capacity is reused; overlapping incarnations cannot publish with obsolete tokens even if replacement starts before leases expire.
Reserved control capacity cannot make CPU-blocked JavaScript responsive, which is why the independent watchdog is required.
Initial worker-wide termination may interrupt siblings; [the accepted execution boundary](providers-execution.md#managed-attempt-cleanup) records unknown effects and prohibits replay.
Actual supervisor/process exclusion, grace and replacement timing require host proof.

## Encryption and maintenance replacement

Use a standard authenticated envelope through the maintained runtime crypto adapter: version, key ID, fresh 96-bit nonce, ciphertext and full 128-bit tag with AES-256-GCM.
Bind record kind/ID, provider where applicable and authority/credential or payload revision as versioned authenticated context.
Never reuse key/nonce, accept truncated tags or release plaintext before integrity verification.
The adapter covers entrusted/provider/client/source/setup secrets and private job payloads; high-entropy session/registry credentials use one-way verifiers instead.
Keys reside in protected host custody outside the encrypted database and browser APIs; startup rejects missing required keys and failed authenticated probes.
These are mechanism choices to implement/test, not claims of deployed key management.

Offline `secrets:reencrypt --from <id> --to <id>` uses the same adapter and accepted maintenance downtime:

1. Stop ingress, every API/worker/command writer and automatic replacement; verify process exclusion, including callbacks and renewal paths.
2. Preserve unresolved dispatched setup/import/renewal/source/job state and mutation barriers; stopping a process does not prove a provider call had no effect.
3. Keep old/new keys protected and take an exclusive maintenance lock against another rekey command.
4. Read metadata first, then authenticate and re-encrypt at most one large envelope at a time within a byte budget; atomically replace each only after successful conversion.
5. On interruption, resume by authenticated key ID, skipping verified new-key records; unknown keys, invalid tags/context or missing keys stop without overwriting evidence.
6. Verify complete protected-record coverage/integrity before switching active key and reopening compatible processes; retain old keys while backups require them.

No plaintext artifact, per-secret log, batch of near-cap payloads or online key-rotation service is introduced.
The database maintenance lock alone does not exclude normal writers, so verified host process exclusion and disabled automatic restart remain mandatory.
Successful and interrupted recovery drills are required before support claims.

## Standard database durability and backup loss

Use ordinary Postgres persistence/restart behavior.
Restoring an older backup accepts loss of later admissions/results, authority changes and revocations; external side effects are not undone and missing keys cannot deduplicate the lost interval.
No application restore generation, quarantine, mass reconnection, session-purge/access-reconfirmation procedure or custom restore runbook is added.
Encrypted backups still require their original protected keys.
Actual durability/backup configuration is unverified.

## Security boundary and extension

Use least-privilege service data roles and a separate migration role, protected database/broker networks, verified TLS and trusted-ingress configuration that ignores arbitrary forwarding headers.
Health endpoints reveal no secrets or raw configuration/database errors.
API/worker/operators are trusted peers; provider callbacks, browser clients and registry management authenticate separately.
New providers reuse owned adapters; persistent state is added only for a concrete invariant, and stronger isolation/delivery remains a justified extension rather than another default platform.
