# Providers, native proxy, capabilities, and optional jobs

Status: integrated contracts for the accepted architecture; runtime/provider proof remains future work.
Providers owns external protocol interpretation, Transport owns native forwarding, and Jobs owns durable work and all transitions.
[Shared contracts](contracts.md) owns types, semantic submission comparison and public views; [Access](access-connections.md) owns connection identity/credential lifecycle.

## Provider registration and shared flows

One static registry declares schemas for shared configuration, connection inputs/context, credential bundles and safe display metadata, supported protocols, endpoint families and optional capabilities/events.
Operators configure registrations; there is no downloaded code, expression language, plugin framework or per-app feature-permission layer.
Common OAuth/import/derived flows own setup, renewal and persistence; hooks supply only documented differences in parsing, signing, discovery, rejection interpretation or verification.
Hooks receive bounded scoped data, signal/deadline and shared transport, then return values for the owning core module to validate and publish.
Provider lifecycle declarations identify possibly invalidating steps and supported recovery/independence evidence; all existing-connection setup/import/renewal publication uses [Credentials arbitration](access-connections.md#competing-credential-mutations), never a hook-owned replacement path.
They never receive database access or own route responses, claims or authority decisions.
A standard provider requires configuration and fixtures without changing existing provider logic or adding routes/tables.

Compatible configuration changes preserve connections.
Changes to issuer, client, credential meaning, grant continuity or credential destination must be classified before publication; incompatible changes fence affected authority rather than redirect old credentials silently.
Validate desired configuration outside locks, then atomically publish affected rows under the scoped order; lock actual parent rows rather than a global guard.
Capability versions fix input validation, response semantics and supported invocation modes, using the registration's connection mode rather than another permission policy.
Ordinary invocations drain on upgrade and pin only their in-flight code/configuration; they create no retained-version obligation.
For deliberate Jobs, preserve executable versions while active jobs need them and comparison schemas while retained metadata needs them.
Retire code after those obligations end, rather than retaining every historical handler forever.
An incompatible deployment settles affected work honestly before removing its version, without automatic replay.

## Provider event lifecycle

[Events](events-http-sdk.md#source-lifecycle-state-and-execution) owns source identity, audience and state.
Each integration declares manual/operator, Data App or service setup ownership and only the create/renew/retire hooks it actually needs.
Native source setup remains available through the proxy but does not establish service routing or an SSE subscription.
Provider-wide source lifetime is independent of browser closure; connection-bound sources follow that connection's generation and retirement.
Mutating hook ambiguity requires documented safe recovery or attention, not blind recreation.

## Native forwarding and transport

Authorize current service identity/site, configured registration and selected personal/operator/no-credential mode before dispatch.
Provider permissions govern business operations; routine endpoint wrappers, allowlists or an effect taxonomy are unnecessary.
Use the coherent read-only [request snapshot](persistence-operations.md#ordinary-request-snapshots) and one maintained URL/HTTP transport boundary for proxy, capability, token, discovery and lifecycle calls.
An already-usable A18 bundle requires zero logical writes and no shared-lock checkout commit.
A context-dependent endpoint is unready if required validated context is absent; never fall back to another instance.

Resolve a relative native path within its approved endpoint family using maintained URL primitives and one normalized representation.
Reject userinfo, fragments, authority/scheme replacement, ambiguous separator/base-path escape and credential-owned query/header collisions.
The final hostname/port/path policy comes from operator configuration plus validated provider context, not a caller-supplied absolute URL or next-page link.
Check actual socket recipients through the same guarded resolver/connector used to connect, preserving TLS hostname/SNI and certificate verification; an early DNS check followed by unrelated resolution is insufficient.
Default routing denies local/private/control/metadata destinations; deliberately configured private providers may use narrow operator hostname/port/address-range routes where deployment policy permits.
A private-provider exception must not authorize cloud metadata, service control endpoints or input-driven credential redirection.
Use maintained parsing/resolution/network primitives rather than a bespoke general protocol stack.
Trusted custom clients have equivalent obligations that the shared helper cannot enforce outside its path.

The initial client does not follow redirects or automatically replay requests.
A safe native Location is inspectable data, not authority to send credentials there, and relative locations are not rewritten into service routes.
[HTTP/SDK](events-http-sdk.md#native-response-carrier) carries 3xx and tunneled HEAD responses explicitly because browser manual redirects are opaque.
Future controlled following is a separate extension requiring bounded hops, per-hop recipient/TLS checks, method/body semantics and replayable-body handling; it is not enabled by native redirect inspection.

Preserve native methods, repeated queries, JSON/text/binary/multipart bodies, useful headers, response status/errors and pagination.
Support GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS; unsupported methods/upgrades fail explicitly rather than being converted to GET.
The SDK automatically selects the POST carrier for supplied GET/HEAD bodies, including empty bodies, and Transport sends the original method/raw body upstream without per-endpoint opt-in.
Actual provider/intermediary acceptance remains an integration fact.
File/Blob/FormData represents browser-selected bytes, never a service filesystem path; browser FormData generates its own boundary.
Stream uploads with backpressure and configured service/provider limits without whole-file buffering, retry storage or a service-owned upload UI.
Native multipart/resumable/signed-destination support follows documented provider routing and browser support rather than a universal upload engine.

Protect authenticators entrusted to this service, including derived checkout material and secret-bearing context.
A known endpoint returning the actual entrusted authenticator needs a narrow documented block or verified filter before release.
Intentionally returned native provider-created credentials are permitted output, including authorized shared-account operations; no generic mint/export classifier, scanner or provider-feature ban applies.
Do not rewrite ordinary provider business fields or scan arbitrary streams as a claimed secrecy guarantee.

Use Node low-level byte streaming with transparent upstream decompression disabled and no downstream recompression for unchanged responses.
Preserve valid Content-Encoding, Content-Length, Range/Content-Range and validators for the actual representation; remove hop-by-hop framing and let the HTTP stack generate downstream framing.
For deliberate transformations, update/remove affected representation metadata.
There is no arbitrary total response-byte cap; bound live memory, aggregate pending bytes, sockets, parser/header work and stalled transfers instead.
Account actual upstream body bytes after transfer framing and before content decoding for resource diagnostics and any justified integration-specific transfer limit.
A 206 transfers only its partial body, while HEAD/bodyless statuses transfer zero regardless of representation metadata.
The browser may decode bytes, so upstream accounting is not a browser-memory bound.
Connect, response-header, upstream no-progress and downstream stalled-write timers are separately configurable from measured host/provider behavior.
A healthy progressing stream has no short total lifetime; do not insert heartbeat bytes into native provider content.
No body accumulation belongs in parsers, telemetry, SDK defaults or cleanup.

Before commitment, return distinguishable service transport errors where possible.
After commitment, terminate the failed stream without appended JSON, invented clean completion or replay; native status already sent cannot be retracted.
Detection of truncation depends on framing/native protocol and must be tested honestly.
Abort/disconnect releases local resources without promising remote rollback.
The [shared header codec/profile](events-http-sdk.md#header-budgets-and-control-integrity) bounds physical parser/control work without independent contradictory allowances.
No automatic business retry follows credential repair or provider rejection; the author may explicitly repeat with provider idempotency semantics where supported.

## Backend helpers and pagination

Trusted handlers prefer the shared authenticated helper; explicit scoped custom-client checkout preserves original identity and renewal while placing equivalent transport/secrecy/cleanup duties on that author.
No direct secret mutation, independent credential cache or per-step business dispatch ledger is added.
Native pagination preserves provider parameters/cursors; capabilities define their own typed paging input/output.
Only an integration needing sensitive continuation adds protected state with explicit owner/account binding, expiry and failure semantics.
No universal cursor table, encrypted cursor format or snapshot guarantee is implied.

## Ordinary capability invocation

A named capability adds reusable trusted provider code, not a new execution framework or policy boundary.
M04 owns its static definition/handler, M08 invokes it inside the current API request, and M05 owns the same transport/resource scope used by A18.
A19 advertises supported invocation modes; A39 invokes an HTTP handler, while A20 explicitly submits a supported Job handler.
A definition may provide either or both entrypoints, sharing ordinary provider functions where useful; no flag, timeout or response size silently changes the chosen mode.
No provider is required to have capabilities, Jobs or event hooks.

A39 accepts the versioned capability reference and optional connection selection, with either declared schema-validated JSON arguments or a native HTTP body using the existing transport controls.
The static HTTP input contract selects the form; the SDK rejects incompatible combinations rather than guessing from content or buffering a file into JSON.
M08 consumes the service bearer/connection controls and passes only declared arguments or filtered native headers plus an owned body stream to the handler, without a Fastify request or caller-selected authority.
Native file/multipart/stream bodies use the same backpressure, framing, upload limits and cleanup as A18, without mandatory capability input schemas or saved bytes.
JSON arguments are function input rather than a persisted Job command, and A18 remains available directly without a reusable handler.
A capability returns either declared validated JSON or a native HTTP Response, including an incremental body, according to its static response contract.
JSON returns 200 with its declared media type; native Responses use the same status/header/no-follow carrier and late-failure rules as A18.
M08 marks handler-constructed JSON as service-origin and genuine native pass-through as provider-origin using transport metadata, never a spoofable handler/upstream control header.
There is no JobView, submission key, saved result, progress record, retention clock, callback binding or durable cancellation API on this path.
Job JSON caps and execution/retention limits do not govern ordinary inputs/outputs; measured parser/CPU/byte budgets still apply before allocation, with actual limitations exposed honestly.
Entrusted-secret custody remains identical for all paths, and useful native data or intentionally returned provider-created credentials are not artificially removed from capabilities.

Use the same current session/site/registration/owner or explicit shared audience and connector freshness as A18, without capability grants or duplicated provider ACLs.
Bind the original registration/connection once for the invocation; each later provider operation takes a fresh authority/bundle snapshot for that binding, never another default account.
Reuse a prepared snapshot only for the first immediate operation it authorizes, not across asynchronous business steps or requests.
A released ordinary operation may finish across overlapping revocation or fixed session expiry; expiry/revocation denies a later helper operation, and ordinary code never acquires a started-Job continuation exception.
An in-flight HTTP result follows that request's authorization boundary, not the retained-Job two-stage disclosure transaction.

Client abort, disconnect, handler failure and shutdown close the request resource scope; after response headers, terminate failed bodies without appending a service error.
The returned HTTP body transfers explicitly to that scope and stays owned until consumed/closed; credentials, unread intermediate bodies and detached work cannot escape it.
No request becomes durable on page closure or API restart, and lost responses can leave unknown provider effects.
Neither SDK nor service repeats the invocation; explicit caller repetition uses the provider's actual idempotency semantics, with no generic business ledger.
Safe handler errors use the shared service vocabulary; returned native provider errors retain their status/body, and raw exceptions stay private.

Trusted request handlers must cooperate with AbortSignal, bounded cleanup and measured computation budgets; healthy native streams retain their progress-based transport timing.
They use normal API drain/liveness handling, not Job leases, heartbeats, progress scans or a per-capability watchdog framework.
Uncooperative trusted code can affect sibling API requests; record and test this ordinary in-process extension risk rather than promising isolation or adding durable machinery to hide it.
If evidence requires stronger isolation, treat that as a concrete extension decision.

## Durable admission and execution

Only explicitly selected durable work uses the owned Postgres Jobs table and worker role.
A20 rejects a capability version without a Job entrypoint; A39 never admits work to this table.
[Submission comparison](contracts.md#submission-identity-and-comparison) defines idempotency; the admission sequence is:

1. Authenticate current service authority and validate the bounded command against the retained capability comparison schema.
2. Find an existing `(appId, ownerId, submissionId)` and authorize disclosure before comparison/recovery; do not reselect a connection or allocate new-job payload capacity for equal recovery.
3. For a new command, reserve measured preparation resources, resolve current capability limits and connection/account authority, and prepare validation/comparison/encryption outside locks.
4. Under [ordered locks](persistence-operations.md#transactions-concurrency-and-failure), recheck current authority/freshness and atomically insert encrypted input with immutable metadata and the unique key.
5. On a unique conflict, release the failed transaction and perform current-authority existing-row recovery; never acknowledge before confirmed commit.
6. Return 202 for new work or 200 for equal retained work; an uncertain response is recovered with the same key, not a newly generated submission.

No pending-job count quota or speculative future-result reservation is made.
An actual allocation/storage/commit failure is explicit; failure after remote execution cannot justify replay.
Input/result/duration policy and exact byte accounting are owned by [contracts](contracts.md#managed-capabilities-and-jobs).
A job stores submitter deployment/site/owner, app attribution, capability/version, original connection and authority generation, effective limits, comparison version/digest, and separately encrypted execution data.
Its connection selection and account never change through resubmission, observation or reauthorization of a different account.

### Scheduling and claims

Each worker runs the same bounded authoritative scheduler without a leader or queue library.
Indexed Job scans discover queued starts/retries, due external observations, expired claims, cancellation, absolute deadlines and retention.
Run them while at least one configured enabled Job entrypoint accepts submissions or unfinished/retained Jobs remain; independently enable source maintenance only for configured hooks.
References to enabled Job admission mean those configured entrypoints, not a new deployment feature flag or separate policy object.
Core session/handoff/mutation recovery remains necessary without either optional subsystem.
Bound scan rows/time, use stable due-time/submission/ID ordering and pagination, and release database connections between batches.
Use an earliest-due timer plus a configured maximum scan interval, startup/reconnect catch-up and local capacity-release wakeups.
Optional lossy postcommit Redis job-ID hints can shorten latency but never replace scans; producer death after commit cannot strand work.
There is no NOTIFY transport or durable outbox.

Candidates are unlocked ID/scope hints, not privately prefetched running jobs.
Acquire relevant authority rows in order, then lock/recheck the candidate job with `FOR UPDATE SKIP LOCKED`; skipping is for contention, not authorization.
Claim only measured available execution capacity and persist random token, process incarnation, claim kind, lease and attempt count before invoking initial code.
First start sets `startedAt` and `executionDeadline` once; initial queue age never consumes the duration.
A retry after first start keeps the same deadline, even while queued.
Current site/provider/shared audience, capability compatibility, original connection authority and configured connector freshness gate new starts.
Recoverable freshness blockage remains queued with a visible reason; proven same-account reauth can unblock it, while permanent generation replacement/disconnect settles failure without invocation.
The browser session need not remain valid after admission; it is not worker authority.

Every advancing claim/lease/progress/task/result mutation checks expected state, live token/incarnation, lease and fresh database wall time after waits.
Equality with lease/deadline is expired; transaction-start `now()` and a previously sampled application clock cannot grant grace.
Job-scoped checkout uses the same original authority and live claim/deadline, rechecked for each new operation.
The checkout commit is the local authorization boundary; a later disconnect/deadline cannot atomically recall a released snapshot before remote socket send.
Do not claim a physically instantaneous remote cutoff.
Result/task preparation and encryption occur outside locks; recheck on publication.
An eligible original result requires original job identity/claim/deadline and immutable state, not a currently usable provider connection or browser session.

### Recovery and control capacity

Reserve control scheduling, memory and database capacity separately from executing handler slots.
Deadline, cancellation and expired-claim recovery scans must run even when every execution slot is occupied.
Give due observations bounded fair opportunities alongside new starts, and bound source-hook invocation/cleanup so maintenance cannot monopolize control work.
Read-only observation dispatch may use a bounded I/O budget, but its expired-claim recovery never waits for an execution slot.
Choose lease, heartbeat, scan and cleanup timings from measured event-loop/DB/host behavior and validate their relationships; no fixed four-slot or universal polling cadence is selected.

An expired initial execution claim becomes failed/interrupted, even in the claim-before-invocation window; it is never automatically requeued.
A persisted external task remains `waiting-provider`; an expired read-only observation claim can be cleared/reacquired without submitting anything.
Deadline equality settles timeout before any late non-timeout advancement, regardless of delayed maintenance.
Missed cancellation/deadline/claim work is found on bounded scans and startup/reconnect, not through guaranteed wake delivery.
A database outage blocks authoritative writes/checkouts but is a dependency-readiness failure, not proof the process event loop hung.
[Operations](persistence-operations.md#schema-setup-and-process-ordering) owns independent host liveness and confirmed replacement.

## Interruption, external tasks, and cancellation

Automatic business retries default off.
A trusted capability may opt into finite attempts/delays for explicitly returned settled failures under its own duplicate-effect responsibility.
Retry keeps original identity/deadline, uses a fresh claim and waits for prior attempt disposal.
Claim loss, uncertain final persistence or output-validation failure after remote success is never an automatic retry signal.
No retry resubmits an already attached external task.

Jobs persists an external task ID and bounded encrypted observation context before treating tracking as established.
After attempt cleanup, external waiting releases execution capacity.
Prefer verified callbacks; optional provider-supported read-only observations use persisted `nextCheckAt`, due hints/Retry-After and bounded backoff inside the original deadline, with no universal fixed cadence.
Observation failure records a bounded safe error and never invokes initial submission.
If current checkout is unavailable after disconnect/replacement, record blocked observation and await independently verifiable callback or original deadline; never switch credentials/accounts.
Mutating observation requires explicit provider-safe interruption semantics before enablement.

[CallbackBinding](contracts.md#shared-server-interfaces) is persisted before initial invocation for providers that echo a client reference.
Verify source/per-task evidence and bind original registration/account/task or prebound correlation before a callback can attach and advance a job.
A callback may beat handler return; it atomically attaches/completes and fences the superseded claim so late handler/observer writes cannot regress it.
Without prebinding, provider lookup or redelivery must cover early callbacks; a callback-only integration with none of these cannot claim supported tracking.
No generic callback inbox/archive is added.
Send-before-ID-persistence remains unknown external outcome; report it without blind resubmission.
A retained incoming verifier is not an outbound provider credential and can verify original work after disconnect until its execution/retention rules end.
Callbacks commit Jobs independently of Redis and acknowledge only the documented verified transition/duplicate/late handling, never a fabricated durable success after database failure.

### Cancellation and terminal races

A currently authorized cancel request locks the job and records `cancellation.requested`; queued never-started work transitions atomically to terminal `cancelled` against start.
Running work receives cooperative abort; a legitimate eligible success can win if committed before cancellation settlement and before deadline, retaining the request flag.
Waiting-provider cancellation stops local tracking as terminal `cancelled`; it does not await a provider cancel response or claim remote rollback.
At/after the absolute execution deadline, nonterminal work settles failed/timeout; timeout does not set the explicit-user-request flag.
The first eligible terminal transition wins, with immutable completion time/result/retention; late callbacks cannot revive it.
A remote task ID returned while cancellation raced submission is retained under the original live claim before local cancellation is applied.
If cancellation/timeout terminalization already won, late task identity may be recorded only before the separately fixed cleanup deadline, using the retained original invocation token/incarnation and validated original provider/account binding.
This conditional metadata write accepts an absent task identity or the identical existing identity, never replaces an attached task, extends a deadline, accepts a result or revives execution.
Wrong/superseded invocation tokens and callbacks without the retained verified task/prebound correlation are rejected.
Unverified or wrong-account IDs are rejected.

Optional provider remote cancellation is a separate bounded cleanup attempt on the terminal job for a known original task, selected for explicit cancellation or timeout only where the integration supports it.
It has its own token/incarnation/lease and cleanup deadline, can survive execution deadline expiry, and can perform only cancellation of that recorded task.
Before sending, take current authority/connection/job locks, require matching original account generation and permitted current credential use, and atomically set an irreversible `issuedAt` marker with the cleanup claim.
No outbound call occurs before that marker; no uncertain issued cancellation is retried after crash/lease loss.
An expired undispatched cleanup claim can be reacquired within its cleanup deadline because old dispatch predicates are fenced.
Unavailable/revoked credentials are never retained or resurrected; record unavailable/unconfirmed/unsupported honestly.
Provider evidence alone establishes remote confirmed; an acknowledgement without confirmation remains unconfirmed.
Cleanup may update only bounded remote status/task metadata, never terminal execution/result/completion time or retention.
If cancellation raced a legitimate success, do not automatically cancel a successfully completed operation solely because the request flag remains true.
No revocation-triggered active-job cancellation, compensation engine or general cleanup queue is added.

### Managed attempt cleanup

Transport owns common request/socket/body disposal; Jobs adds the worker attempt scope for execution, observation and cleanup.
Events reuses the bounded worker scope for source hooks while retaining ownership of source state; it does not create a Job or saved result for each hook.
Transport registers operations and response-body handles until consumed or closed.
Return, throw, external waiting, claim loss, callback fencing, cancellation and deadline all enter bounded finally disposal.
Abort outstanding transports and cancel/release unread bodies rather than draining them; no Response, stream, credential scope or background Promise may escape into a later attempt.
A `Promise.race` timeout or database terminal state does not prove JavaScript or sockets stopped and never releases capacity by itself.
A never-settling Promise can leave heartbeats healthy, so monitor per-attempt progress toward cancellation/disposal deadlines independently of process heartbeats.
On failed disposal, stop new claims, mark worker draining, and request whole-process termination through the host supervisor.
A blocked event loop cannot run its own timer, so the external supervisor independently monitors responsiveness and force-terminates within a configured bound.
Confirm process exit before its capacity is reused; replacement recovery uses persisted claim/lease/incarnation state.
Sibling handlers can be interrupted, with unknown remote effects and no replay; that initial tradeoff is accepted and requires host/mixed-load proof.
Per-attempt child isolation is the extension if measured collateral disruption or control starvation warrants it, not a mandatory initial service topology.

## Results and retention

A terminal commit atomically stores validated encrypted result/reference and immutable completion/expiry metadata; failure to commit is not durable success.
Delete execution input when no longer needed, retaining semantic comparison/schema data for the metadata lifetime.
[Access disclosure](access-connections.md#disclosure-and-trust-boundary) permits current authorized retained reads after provider disconnect without credentials.
Authorize an immutable body reference before loading, prepare authenticated plaintext outside locks, then recheck current disclosure/retention/reference before logical release.
No payload decryption, large copying or network drain holds authority locks.
Result expiry returns explicit expired status without rerunning; metadata deletion ends duplicate-admission protection.
Nonterminal jobs are not deleted for age alone, and reads/callbacks/remote cleanup do not extend retention.

## Job transition contract

| State | Actor and transition | Fence/recovery |
| --- | --- | --- |
| `queued`, never started | Current-authority worker starts; current submitter cancels; permanent start-authority loss fails. | No queue-age expiry; freshness-only blockage waits visibly. |
| `running` | Live initial claimant settles result/failure or attaches external wait; verified prebound callback may attach/settle. | Lost initial claim is interrupted, never automatic requeue. |
| Settled retryable attempt | Explicit author policy schedules same job back to queued after cleanup. | New claim, same account and absolute deadline; uncertainty is ineligible. |
| `waiting-provider` | Verified callback or live read-only observer advances; cancel/deadline may settle. | Observer lease loss permits observation recovery, never submission replay. |
| Any started nonterminal | Deadline recovery commits timeout at equality or later. | Late progress/checkout/outcome fails even if recovery was delayed. |
| Terminal | Current authorized read, retention deletion, narrowly bounded optional remote cleanup metadata. | Execution/result/completion immutable; cleanup cannot revive work. |

## Provider extension checklist

Add only the definition, supported protocol/context/credential semantics and relevant fixture tests needed by the integration.
Use Slack for the first native integration tests and an illustrative optional capability, without choosing a bespoke Slack feature or requiring a Job.
Verify native access before optional capabilities/events, and prove second-provider reuse early in the [build plan](../planning/build-plan.md).
Document real destination/private-routing requirements, known entrusted-secret retrieval exceptions, task verification/correlation and source lifecycle uncertainty.
Use official provider evidence rather than assumed universal SDK compatibility.
