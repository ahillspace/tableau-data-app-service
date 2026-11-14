# Verification and evidence boundaries

Status: executable future acceptance plan for the accepted architecture; no application test below has run.
This document owns proof obligations, while component specifications own behavior.
User architecture acceptance includes the initial worker-wide interruption tradeoff; independent document convergence, implementation verification and delivered user acceptance remain separate.

## Existing evidence and limits

The [published Cloud observation](specs/access-connections.md#published-identity-evidence), captured on 2026-11-12 UTC with Extensions API 1.19.0 and Tableau 2026.3.4, initialized a Data App and exposed an opaque uniqueUserId without connectedServer identifiers or Extensions fetch.
A separate top-level login completed backend-verified OIDC and a Tableau site session returning stable site/user IDs for the authorizing account.
It did not prove silent restoration/reauthentication, account switching, media, long-term sessions, cross-app continuity, the proposed service handoff or Tableau Server compatibility.
It did not compare to the embedded viewer, and such equality is not required.

Earlier isolated transport probes observed browser manual-redirect opacity, GET-body Fetch rejection, a synthetic POST carrier reaching an upstream GET with body, raw versus decoded gzip behavior and header-tunnel expansion beyond a tested runtime parser limit.
Those observations motivate the native carrier/representation contracts but do not verify this service, real provider/intermediary support, published Tableau transport or deployed ingress.
No runtime queue/load/database/Redis/host/key-recovery test is claimed from source inspection or these primitives.
Historical reviews certify only their frozen source/evidence scope.
Document hashes, links, semantic review and local viewer/export checks establish a reviewable artifact, not application support.

## Harness and release scope

For later authorized implementation, use real Postgres and two API replicas; exercise two worker replicas when validating background execution/core maintenance and real Redis only where events are enabled.
Ordinary native/capability tests must run without Job admission/handlers or Redis, while the accepted topology's bounded core maintenance remains owned.
Use controlled synthetic providers and process/network fault injection so external sends and invocation counts can be observed independently of local job state.
Cedar exercises shared OAuth/rotating tokens, two approved account-specific instances, native writes/files and external tasks.
Flint exercises static/operator/derived credentials and only the event source lifecycle needed by its fixture.
Extend fixtures as features are implemented; use Slack for the first real native/provider capability example while keeping the exact bespoke feature unselected and provider code outside core.
Use actual published Cloud and Server Data Apps for platform claims, with the supported adapter/deployment/browser/CSP configuration recorded.
Test only relevant implemented features for each slice, then the complete supported journey before full-product completion.
Never enable a synthetic identity adapter in production configuration.

Each scenario records an observable failure oracle and one evidence owner; repeated V/B/OpenSpec obligations cite that result instead of requiring duplicate tests.
Use one parameterized real-Postgres mutation fault harness for setup, local/remote import and renewal where each scenario applies, with thin protocol/browser checks for distinct handoffs.
Keep focused codec/schema tests, real concurrency/process faults and actual platform journeys; do not assert exact SQL text, helper names or table/claim counts as correctness oracles.
Interaction/lock-duration traces diagnose consolidation targets, while measured zero logical writes on usable ordinary requests and no Job/input/result/receipt persistence on ordinary calls remain regression obligations.
No test-count, coverage-percentage or mutation-score gate is introduced.

| Scenario evidence owner | Observable oracle | Reused obligations |
| --- | --- | --- |
| Credentials/Connections mutation harness | At most one competing remote mutation; stale publication/recovery cannot change a newer bundle; local import commits all fields or none without replay. | V03/V04, relevant V08 races, B02/B04. |
| Access/Persistence ordinary request journey | Wrong owner/revoked authority denies, bundle/context never mix, usable requests produce zero logical writes. | V02/V08/V14, B02/B08/B09. |
| Transport/HTTP/SDK journey | Native method/status/body/provenance survives, first bytes precede EOF, abort closes resources and business sends are not repeated. | V05/V14, B05/B08 and streaming OpenSpec. |
| Jobs/Persistence recovery journey | One admission, immutable terminal outcome, no uncertain resubmission and current-authority retained reads. | V06/V07/V08/V12/V13, B06/B09; supported hooks only. |
| Events/Providers delivery journey | Current authorized recipients receive valid live data; invalid/retired/aged events deny despite delayed maintenance, while provider-valid delayed events survive renewal-only expiry. | V09/V10, B07/B09. |

These are reusable scenario families, not a required number of tests or a new release gate.

## V01 - Platform identity, handoff and sessions

Owner: Access/HTTP/SDK, E01 and B01/B03.

- [ ] Document official supported registration, callback mode, endpoint and backend deployment/site/user verification for each Cloud/Server adapter; reject browser ID/email/unsigned claims as owner evidence.
- [ ] Run two apps/two owners across both platforms with login, reload, new tab, return, browser restart, blocked/partitioned storage and deliberate account switching; verify correct owner resources and no app-use grant requirement.
- [ ] Move transaction creation, callback and redemption across API replicas; transfer locators, swap state/issuer/callback/window and race duplicate redemption, proving no unbound attachment or bearer release.
- [ ] Exercise actual opaque/null origins: opener verifies service origin/window, service uses supported correlation, and a cookie plus an arbitrary null-origin initiation proof cannot mint bearer access.
- [ ] Evaluate silent hardening only with a simple transparent prototype and record UX/browser/embed/performance impact; CHIPS alone and browser ancestry assertions are not binding proof, and no approval screen or new Tableau feature may be assumed.
- [ ] Demonstrate returning-client binding and the actual restoration/renewal mechanism; if absent, report the incomplete requirement rather than claiming a cookie candidate works.
- [ ] Verify seven-day (604800-second) configurable authentication expiry immediately before/at/after the boundary, including repeated activity/refresh; expired bearer alone fails, newly verified authentication may create new authority.
- [ ] Exercise normal access renewal during provider consent versus true session revocation/expiry, concurrent tabs and wrong owner/site; clear old page views before displaying deliberately established new identity.
- [ ] Record actual consent/MFA/gesture prompts and whether reauth can be silent; verify page closure does not disconnect providers/cancel jobs and adds no service signout UI.

Pass evidence includes actual platform/browser records and negative tests; no viewer-equality or new Tableau feature-request prerequisite is added.

## V02 - Registry and personal/shared authority

Owner: Access/Connections/Persistence, B02.

- [ ] Register configured deployment/site IDs concurrently with a registry-only credential; verify one record, atomic attribution, no implicit re-enable and no identity-field patch/migration.
- [ ] Reject ordinary viewer/provider credentials, forged email headers and arbitrary issuer/discovery input on management routes; registry credentials cannot call private provider APIs or impersonate users.
- [ ] Admit any verified email domain on an enabled site; distinguish the same site/user IDs under different deployments and prove controlled URL alias changes require continuity evidence.
- [ ] Use one owner's personal connection/job across configured apps without new personal bindings; deny another owner and verify app ID changes cannot broaden shared authority.
- [ ] Add a site and race explicit shared-site/user audience inserts/deletes against checkout/start/disclosure, including absent membership; only explicit current audience grants access.
- [ ] Disable/re-enable a site during sessions, queued/running work and events; next site-bound checks deny without deleting retained results or claiming cancellation of already-dispatched work.

## V03 - Provider setup, context and reauthorization

Owner: Connections/Credentials/Providers/Persistence, B04/B08.

- [ ] Exercise personal OAuth/static, operator OAuth/static and derived/no-credential modes with protected setup, current authority and no personal-to-shared fallback.
- [ ] Connect two accounts under one registration with different approved instances; atomic bundles never combine one credential with another context/destination.
- [ ] Fail required discovery on new setup, replacement and post-rotation renewal; affected endpoints remain unready and possibly invalidated old tokens are not reported usable.
- [ ] Race callback/import/discovery publication against cancellation, session expiry, replacement and disconnect; stale claims/generations cannot install secrets or revive routing.
- [ ] On two API replicas and a worker, race provider-interacting setups/imports and renewal against one captured revision; at most one contender sends the external mutation, conflicts are explicit, unrelated connections progress, and no database connection/lock is held during consent, discovery or bounded contender waits.
- [ ] Prepare two strictly local imports, then race publication against each other, renewal reservation, same-account reauth, disconnect and session expiry; reject stale/competing/unauthorized candidates without rebasing, mixed credentials/context or automatic replay.
- [ ] Crash local import before/after commit and lose its response; the complete old or new bundle remains, with no abandoned local processor blocking later authorized use and no automatic reimport.
- [ ] Delay old setup discovery across verified same-account publication and attempt late commit: immutable captured credential generation plus mutation owner must reject it even when authority generation is unchanged; deliberate identical-byte revalidation still advances credential generation.
- [ ] Crash/cancel/expire setup before dispatch, after possibly invalidating exchange/launch and after exchange before required discovery; prove pre-dispatch old-bundle preservation, cumulative invalidation across browser/discovery phases, and unusable uncertainty only for the still-matching expected bundle.
- [ ] Resolve uncertainty with documented safe recovery or a proven independent explicit replacement, then deliver old publication and old recovery scans; neither may overwrite, clear or poison the new bundle/reservation. Without independence evidence, reject automatic renewal and unsafe replacement even after time passes or a new login.
- [ ] Move a verified callback to another API after an explicit browser-wait handoff; a fresh active processor may continue the same reservation, while expired active claims cannot authorize uncertain exchange replay.
- [ ] Reauthorize with verified same-account/client/destination/grant continuity: authority generation remains, credential generation and deliberate reauth time advance, queued freshness-blocked work unblocks.
- [ ] Repeat with unknown/different account or incompatible continuity: generation changes and old jobs cannot inherit new identity.
- [ ] Leave connector interval unset and verify no invented periodic expiry; when configured, refresh does not reset it, while supported deliberate static revalidation and derived-base behavior follow the declared contract.
- [ ] Add a second ordinary provider using configuration/necessary hooks without duplicating routes, storage, renewal or existing provider logic.

## V04 - Renewal uncertainty and entrusted secrets

Owner: Credentials/Persistence, B04.

- [ ] Reuse the V03 mutation harness across setup/import/renewal: two remote contenders cannot both mutate the provider, and stale completion/recovery cannot overwrite or poison a newer bundle; local import publishes all fields or none; attach interaction traces for prepared reserve/dispatch and returned-state reuse as diagnostics, without asserting internal representation or exact SQL shape.
- [ ] Concurrent API/worker requests for the same revision produce one coordinated renewal; unrelated connections progress independently, with bounded waits and no held pool connection during backoff.
- [ ] Kill before and after may-have-dispatched commit, lose rotating-token response, expire a live attempt and deliver late success; only an expired undispatched claim can be replaced without ambiguity recovery.
- [ ] Return successful rotation then fail required-context discovery/validation/publication; preserve unusable uncertainty and reject late token/context revival.
- [ ] Race renewal against setup/import, disconnect/new generation/deadline/claim fencing; require current shared mutation ownership, exact token/incarnation/lease and both generations at publication, with explicit zero-row stale outcome and no poisoning of newer independent material.
- [ ] During the current mutator's potentially invalidating dispatch, deny new old-bundle checkout while retaining its eligible publication authority; verify started-job renewal still uses original account/current authority after ordinary session/connector freshness expiry.
- [ ] Exercise known/non-expiring/unknown/static/derived credentials and omitted refresh-token semantics through supported provider evidence.
- [ ] Attempt entrusted-secret retrieval/logging/context export and helper-derived output; protect them while allowing intentionally returned native provider-created credentials without generic classification/scanning.
- [ ] Verify failed credential repair never automatically repeats the original business request.

## V05 - Native HTTP, files and media

Owner: Transport/HTTP/SDK, B05/B08.

- [ ] Run native JSON/text/binary/multipart, repeated query/header fields, errors/rate limits/paging and browser-selected local files through actual service/SDK; no capability wrapper or local filesystem path is required.
- [ ] Supply empty/nonempty GET/HEAD bodies and FormData: automatic POST carrier reaches original upstream method/body, browser boundary remains correct and conflicting Content-Type/duplicate controls fail before dispatch.
- [ ] Inspect 301/302/303/307/308 and other 3xx plus bodyless 304 through physical 200 carrier, with native status/safe Location and zero follow-up; unexpected front-door redirect rejects.
- [ ] Verify ordinary/tunneled HEAD and bodyless status framing with large representation metadata, null SDK bodies, synthetic Response properties and browser header normalization.
- [ ] Use gzip and ranges to verify unchanged encoded bytes, actual physical encoding/length, one browser decode, 206 partial accounting, 416/validators and no decompression/recompression mismatch.
- [ ] Exercise one shared header profile at/beyond actual runtime/ingress request/response limits, including JSON escaping/base64url expansion, unknown browser-added fields and case-insensitive control/credential spoofing.
- [ ] Confirm oversized metadata fails honestly before commitment, no silent header truncation, and early unmarked HTTP/network failures do not promise service JSON or no provider effect.
- [ ] Probe relative-path/authority/base-path escapes, DNS changes at socket connection, TLS failures, provider-context substitution and credential header/query collisions; explicitly configured private providers work while metadata/control redirection fails.
- [ ] Preserve intentional native new-credential results, while a specifically known entrusted-secret retrieval exception prevents the actual stored authenticator from leaving.
- [ ] Deliver first chunk before EOF; generate long/large transfers with fast/slow concurrent readers, uploads and provider-native HTTP streams, without arbitrary total response cap or SSE envelope injection.
- [ ] Stall connect, headers, upstream and downstream independently; healthy progressing streams survive beyond short wait windows, while abort/late failure releases resources without appended JSON or replay.
- [ ] Prove actual authenticated image/video/download consumption and range seeking in published Cloud and Server through selected ingress; no whole-video Blob or reusable query-bearer shortcut stands in for the required journey.

Measure resident memory, byte queues, sockets, time to first byte and cleanup, rather than infer boundedness from a mocked stream.

## V06 - Admission, scheduling and execution claims

Owner: Jobs/Persistence, B06.

- [ ] Race equal semantic commands with reordered JSON properties and bounded non-UUID keys across APIs; one durable input/metadata row results, changed input/version/selection conflicts and another owner cannot recover it.
- [ ] Lose admission response, change automatic defaults, disconnect the connection or retire executable code while retaining comparison schema; equal current-authority recovery returns the original job before new selection/allocation.
- [ ] Enforce 100000000-byte input/result boundaries and lower trusted limits with exact serialized accounting; reject caller overrides and invalid config without a smaller hidden parser/default allowance.
- [ ] Kill the producer immediately after commit with all notifications absent; bounded Postgres scans/timers and startup/reconnect/capacity-release wakeups still discover committed queued/due work without a Redis scheduler subscriber.
- [ ] Run multiple workers with due-time ordering, bounded scans and no private started-job prefetch; confirm one live claim and bounded observation fairness.
- [ ] Kill at running commit before invocation, after remote effect and before result commit, and during uncertain persistence; expired initial claims report interruption and never replay automatically.
- [ ] Exercise author-opted finite retries only after settled/disposed failure, retaining original identity/deadline and never resubmitting an attached task.
- [ ] Fail actual resource allocation/database commit/disk writes; never report uncommitted durable acceptance or add pending-count/future-result reservations.

## V07 - External waits, cancellation and deadline races

Owner: Jobs/Providers, B06.
Local cancellation, deadline, original-outcome and no-replay guarantees apply to all Jobs.
Full-product completion requires an external-task integration with a complete supported callback and/or observation recovery path; test each optional protocol below only when its declared hook is supported.
Remote-cancel claims/issued markers and late-task-ID cleanup apply only to integrations supporting remote cancellation; without it, prove honest unsupported status and local cancellation without remote work.

- [ ] Persist a provider task ID, release attempt resources and restart workers; recover the declared tracking path without initial invocation; for a supported observer, lose its lease and repeat only read-only observation.
- [ ] For supported callbacks with prebinding, deliver an authenticated early callback before handler return; attach/settle once and reject late superseded handler/observer writes.
- [ ] For supported callbacks without prebinding, test documented lookup/redelivery and reject supported-tracking claims for callback-only providers lacking recovery; all external-task submissions preserve explicit send-before-ID unknown outcome.
- [ ] Expire ordinary browser/connector freshness during started work and verify original account/current authority continuation, while new submission/start fails freshness and never switches accounts.
- [ ] Disconnect during started work: later checkout fails, but eligible original outcome/callback without new credentials commits and saved results remain readable under current disclosure.
- [ ] Queue initial work past 24 hours without starting: no queue-age expiry; first start sets the configured deadline once, with external waits/retries included and no reset by progress/refresh/config changes.
- [ ] Race queued cancellation/start and running cancellation/success/callback/deadline; first eligible terminal state/time/result remains immutable and timeout does not set user-requested cancellation.
- [ ] For supported remote cancellation, return a task ID while cancellation races submission; retain verified original identity only before the fixed cleanup deadline under the original invocation binding, rejecting wrong tokens, changed task IDs and late results without reviving execution.
- [ ] Delay maintenance and test before/equal/after deadline for claims, checkout, heartbeat/progress, attachment and outcome, including a lock wait crossing expiry; late non-timeout advancement is rejected.
- [ ] For supported remote cancellation, exercise post-terminal cleanup with its separate deadline/claim and original account: issued marker commits before send, crash after marker never repeats uncertain cancel, expired undispatched claim can be safely fenced/reclaimed.
- [ ] Verify remote unsupported/unavailable/unconfirmed/confirmed evidence, revoked credential denial, bounded cleanup expiry and immutable terminal completion/retention.
- [ ] Disconnect Redis throughout callback acceptance, cancellation and external observation; durable Jobs transitions remain independent.

## V08 - Real Postgres authority predicates

Owner: Persistence with Access/Connections/Jobs, B02/B06.

- [ ] Race transactional background checkout/start/final-result-disclosure against site/provider/session/connection changes, including non-key updates; a prior committed revocation denies, and overlapping operations obey their specified authorization boundary.
- [ ] Insert/delete absent shared audience membership while transactional readers hold its parent; no missing-child race grants or preserves unauthorized access.
- [ ] Exercise peer-ID ordering, lock timeout/deadlock rollback, explicit zero-row stale results and pool release between retries, with unrelated connection progress.
- [ ] Begin a transaction before lease/deadline expiry and block its required lock until afterward; fresh database wall time rejects advancement rather than transaction-start time granting grace.
- [ ] Reuse obsolete claim token, wrong incarnation, expired lease, wrong authority/credential generation and superseded source revision; each conditional mutation fails explicitly.
- [ ] On usable A18, trace zero logical writes and coherent authority/bundle use; race site/session/provider/audience/connection revocation committed before versus after its statement snapshot, verifying denial versus permitted overlap and no mixed bundle/context, without remote atomicity or SQL-string assertions.
- [ ] Exercise no-credential and automatic/ambiguous selection, unknown config revisions, slow preparation crossing fixed expiry and a later A39 helper call after revocation; no stale permission cache or account substitution is allowed; record redundant fetches as interaction diagnostics.
- [ ] Separately prove background checkout commit and final saved-result disclosure retain their stronger conditional boundaries.
- [ ] Instrument lock duration and demonstrate no provider I/O, large canonicalization/encryption, payload decoding or stream drain under authority locks.
- [ ] Authorize payload reference, revoke while preparing plaintext, then attempt release; current recheck denies new logical disclosure, while already-released bytes are acknowledged as irreversible.

## V09 - Redis loss, bytes, age and current delivery

Owner: Events/HTTP/operations, B07.

- [ ] Start events disabled with no Redis deployment/client; auth/proxy/Jobs/callbacks work and no broker connection is attempted.
- [ ] With events enabled, distribute SSE across APIs and publish on any replica/worker; every API subscribes before event readiness, local publish uses one subscriber path and no second database relay exists.
- [ ] Stop broker/publisher/subscriber separately, including ambiguous publish and reconnect; core readiness remains usable, new event forwarding fails honestly, durable callbacks commit and missed notifications do not lose Jobs.
- [ ] Verify zero subscribers is an acknowledged drop, one stalled client does not block healthy ones/provider acknowledgement, and offline/ambiguous publishes are not automatically retained/retried.
- [ ] Exercise logical payload exactly at cap and beyond, multibyte JSON/raw payload, envelope bounds, base64url expansion and SSE framing; every accepted payload fits the downstream logical allowance without truncation.
- [ ] Delay broker/socket/worker queues, skew clocks within/beyond configured tolerance and inject future timestamps; check age on receipt and logical delivery and discard expired/obsolete data.
- [ ] Batch immediately deliverable recipients with one current authorization read and no async gap, then queue a slow recipient and require a fresh delivery check; no event-body writes or stale authority reuse.
- [ ] Revoke session/site/shared membership or retire source between enqueue and delivery; current authoritative checks deny despite lost invalidation messages or misleading channel/audience hints.
- [ ] Reuse V10's provider-specific validity fixtures for queued events crossing deadlines while maintenance is paused: reject actual event-validity expiry but preserve a valid signed delayed event across renewal-only/subscription expiry, subject to current authority, revision and envelope age.
- [ ] Saturate publisher, subscriber decode/work, broker client and individual/aggregate SSE byte budgets independently; no unbounded per-recipient Promise, offline queue or slow-reader coupling remains.
- [ ] Reconnect clears old queues, resubscribes only for future events and signals resync; true denial stops reconnect, ordinary valid-session renewal can reconnect without business replay.
- [ ] Verify deployment channel isolation, TLS certificate checks, separate publish/subscribe privileges/ACLs and absence of private payload/entrusted-secret logs.

## V10 - Source ownership and uncertainty

Owner: Events/Providers, B07.

- [ ] Exercise declared manual, Data App and service setup only where supported, preserving provider-wide sources after browser closure and keeping native setup distinct from service routing.
- [ ] Race create/renew/retire hooks against source revision, audience edit, connection generation change and claim/lease loss; stale results never restore retired routing.
- [ ] Kill before/after mutating hook may-have-dispatched and lose the response; uncertain outcomes become attention-required unless documented provider recovery proves safe continuation.
- [ ] Pause maintenance with unchanged source revision and stored active state; test before/equal/after each provider-defined ingress/delivery validity boundary, proving time checks deny invalid events without waiting for a state update.
- [ ] Separately cross advisory renewal time or subscription expiry where the provider permits signed delayed events: report degraded source health while accepting otherwise valid ingress/queued delivery within envelope age; a provider with no expiry acquires no fabricated cutoff.
- [ ] Verify signature/replay-invalid, retired/replaced and envelope-aged events still deny in those fixtures; overdue maintenance never triggers blind create/renew replay.
- [ ] Bound hook execution/disposal using M09/M05 with Jobs disabled, and prove source recovery does not retain revoked credentials or monopolize reserved control capacity when Jobs are enabled.

## V11 - Encryption and offline maintenance

Owner: Persistence/operations, B02/B09.

- [ ] Tamper tags/ciphertext/context, swap envelopes across records/generations and remove required keys; fail closed with no unauthenticated plaintext release.
- [ ] Stop all writers and automatic replacement, verify process exclusion and run offline rekey one large envelope at a time under a byte budget; no plaintext artifact/log is created.
- [ ] Interrupt before/after each envelope replacement, resume by authenticated key ID, stop safely on wrong/unknown keys and verify complete coverage before reopening.
- [ ] Verify old backup key custody and preserve unresolved renewal/source uncertainty through maintenance; no custom restore-generation subsystem is expected.

## V12 - Host recovery, resources and upgrades

Owner: Operations with all affected owners, B06/B09.

- [ ] With Jobs/events disabled, verify core session/handoff/mutation expiry recovery still progresses and no Job scans/slots/heartbeats gate ordinary routing; retained/unfinished Jobs keep necessary recovery/cleanup enabled after admission is disabled.
- [ ] Run a never-settling background Promise with healthy heartbeats, an ignored AbortSignal, unread body and stuck cleanup; attempt deadlines stop claims and cause confirmed worker termination before capacity reuse.
- [ ] Run a CPU-blocking loop while sibling handlers, observations and source maintenance are active; independent host liveness forces exit/replacement without relying on the blocked event loop.
- [ ] Observe sibling interruption/unknown effects and no automatic replay; replacement scans persisted external waits, expired claims, cancellation and deadlines correctly.
- [ ] Saturate execution slots and demonstrate reserved control scheduling/database resources still recover expired claims/deadlines/cancellation and provide bounded observation fairness when the loop is responsive.
- [ ] Remove Postgres while event loop remains responsive and distinguish dependency readiness from liveness; remove Redis and degrade only events, without cycling every healthy API.
- [ ] Mix near-cap input/result JSON, canonicalization/crypto/driver copies, authenticated result reads, uploads/media, authentication and callbacks; measure RSS/event-loop delay/pool waits/control latency and choose physical budgets from evidence.
- [ ] Verify aggregate database/broker/socket budgets across all replicas, control reserves, maintenance and deployment overlap; no isolated default is multiplied beyond capacity.
- [ ] Drain in-flight ordinary HTTP capability versions without retaining their code for Job retention; test clean/failed migrations and compatible old/new API/worker overlap with active Job/observer versions and incarnation fencing; incompatible upgrades exclude all writers/automatic restart.
- [ ] Send graceful and forced termination during streams, renewal and task submission; stop admission/claims first and preserve the specified uncertainty rather than assuming shutdown completed.

No host, price, workload, slot count, throughput or SLA is proven until these measurements exist.
Per-handler children remain a justified extension if the accepted initial worker boundary fails measured recovery/disruption needs.

## V13 - Retention and disclosure

Owner: Jobs/Access, B06.

- [ ] List/read own jobs across configured apps with bounded keyset filters; no other owner/shared-audience leak, private body prefetch or personal app-use grant occurs.
- [ ] Disconnect a provider and read retained original results with current service identity/site/ownership/shared audience; new provider checkout stays denied.
- [ ] Expire body at seven-day configurable policy and metadata at thirty-day configurable policy from immutable completion; reads/callbacks/remote cleanup never extend them.
- [ ] Return explicit not-ready/no-result/expired behavior, delete unnecessary execution input while preserving command comparison/schema, and never rerun for a result read.
- [ ] Preserve nonterminal jobs until completion/deadline handling, delete expired bodies without decryption and process cleanup under byte/time limits.
- [ ] Delete terminal metadata and verify key reuse may create new work with no remaining duplicate-admission guarantee.

## V14 - Ordinary capability execution and database economy

Owner: Providers/Transport/HTTP/SDK with Access/Credentials/Persistence, B05/B08.

- [ ] Discover HTTP-only, Job-only and dual-entrypoint fixtures; invoke A39 versus explicitly submit A20, rejecting unsupported modes without fallback or a new capability grant.
- [ ] Run declared JSON and raw/multipart streamed-input handlers without JSON/base64 file conversion, plus direct JSON and incremental native-response handlers, preserving useful native data/errors/headers and intentional provider-created credentials under the same entrusted-secret custody boundary.
- [ ] Reuse V05's carrier/browser journey for A39 handler-built 302 and bodyless 304, direct streamed 200 and transformed output with service origin, plus unchanged provider 302 with provider origin; A18 rejects service-origin metadata, spoofed controls cannot set provenance, front-door redirects reject, and precommit/late failures dispose without replay; service-origin HTTP output resolves at headers without forced JSON/error parsing or rejection.
- [ ] Invoke with Jobs/Redis disabled and observe provider sends plus HTTP results independently; no input/result/Job/receipt rows, submission-key hashing, progress or hidden polling is created.
- [ ] Revoke authority or expire the session/connector interval between two helper operations; the later operation denies while an already-authorized operation may finish without being given Job continuation authority.
- [ ] Abort before headers, disconnect during streaming, fail after remote success and restart the API; dispose resources, report only observable failure/unknown effects and never replay or promote work to a Job.
- [ ] Exercise HTTP output body ownership and unread intermediate bodies; normal API drain/liveness and measured handler CPU/cleanup protect physical resources without Job leases/watchdogs, with trusted-handler collateral disruption recorded honestly.
- [ ] Reuse the owning login/restore/discovery/refresh/Job/event/maintenance scenario traces as the database-economy index; diagnose redundant work without creating another comprehensive suite or exact SQL/helper/table-shape assertions, and retain the measured zero-write/no-Job-storage obligations above.

No measured SQL count, latency gain, query plan or runtime correctness is claimed until these checks run.

## Reporting completion

For each implemented gate, record source revision, environment, exact command/scenario, observed outcome and remaining limitations without secrets or personal/workstation identifiers in product documents.
Run applicable formatting/lint/type/build plus meaningful database/process/browser tests when application code exists.
Inspect actual user flows for useful status/error/account/media behavior and accessibility; a mocked unit test or build alone is insufficient.
Document-only validation reports must label snapshot/link/manifest/viewer checks separately from these unrun gates.
No new code or platform is created by this specification task.
