# Access, connections, and credentials

Status: integrated technical contracts for the accepted scope; browser/provider behavior remains unverified except for the evidence explicitly recorded below.
Access owns verified owners, sessions, site eligibility and shared audiences; Connections owns setup and connection identity; Credentials owns entrusted material and renewal.
[Shared types](contracts.md) and [scoped transactions](persistence-operations.md#transactions-concurrency-and-failure) are reused throughout.

## Common session and Tableau direction

Both Tableau Cloud and Tableau Server Data Apps use a shared adapter contract returning server-verified deployment, stable site and stable user identifiers with authentication time and evidence provenance.
Each configured deployment selects an adapter and approved issuer, discovery, validation and callback endpoints from its supported protocol.
URLs are controlled deployment attributes, not mutable owner keys; identical site/user IDs in different deployments are distinct owners.
Configuration cannot silently link owners when a URL alias changes; continuity requires verified deployment evidence.
No endpoint is discovered from an arbitrary browser-supplied host, site name or email.
OIDC adapters use maintained libraries for signature, issuer, audience, nonce and time validation, plus supported subject/site verification; non-OIDC adapters must document equivalent supported evidence.
Never infer a human from client credentials, unsigned/decoded claims, an opaque browser user ID, an allowed origin or an existing Tableau cookie.
Separate verified login is sufficient; matching the embedded viewer is not a requirement.
Do not add a Tableau feature-request dependency, alternative user directory or browser-only identity fallback.

## Published identity evidence

A published Tableau Cloud Data App observation captured on 2026-11-12 UTC used Extensions API 1.19.0 and Tableau 2026.3.4.
Initialization succeeded; the runtime exposed an opaque `uniqueUserId`, while connectedServer site/user/workbook identifiers and Extensions fetch were absent.
That browser identifier is not the server-verifiable owner key.
A separate top-level login completed authorization-code exchange with PKCE S256 and backend OIDC verification of signature, issuer, audience, nonce and time, with UserInfo subject matching the signed ID token.
The authenticated flow also established a Tableau site session and returned stable site and user LUIDs for the authorizing account.
This supports a separate verified login/site-identity path in that environment.
It did not compare the authorizing account to the published viewer; such equality is not required.
It did not prove silent restoration/reauthentication, account switching, long-term sessions, cross-app continuity, the proposed popup/redemption mechanism, media transport or Tableau Server compatibility.
D01/E01 remain partially evidenced; no implementation or support claim follows from this observation.
Public evidence contains no personal/site/workbook identifiers, credentials or private evidence locations.

## Recommended session prototype

The concrete bearer candidate uses a random high-entropy opaque access token in SDK memory and the HTTPS Authorization header, with its verifier, owner/session reference, expiry and revocation state in Postgres.
Access tokens derive from a stable service session; app context is validated configuration/attribution rather than a personal resource grant.
One session stores `verifiedAuthenticatedAt` and an absolute `authenticationExpiresAt` from the configured maximum, initially seven days (604800 seconds).
Ordinary renewal/restoration cannot change either boundary; equality is expired and only a newly verified Tableau authentication can establish another session.
Do not add inactivity expiry, user-facing signout, account synchronization with Tableau signout or a second local identity product.
A deliberately established new identity replaces page-local authority and clears old private views before exposing new data.
The authorizing service account is explicit; browser hints cannot retarget it or claim automatic viewer synchronization.
Page closure clears local tokens/listeners/transports without disconnecting providers or cancelling jobs.

One shared handoff implementation serves login and provider authorization.
For initial login, the SDK creates a random initiation secret and sends only its verifier with the configured app/deployment selection to create an inert expiring transaction.
The user opens the service-origin window through a supported gesture; the opener validates the service origin, expected window and transaction before transferring the initiation proof.
The service validates the expected window/transaction and proof using the supported channel; it must not require exact-origin identification of an opaque/null opener or treat `null` as app authentication.
A locator alone cannot launch or redeem, and an inert GET does not begin OAuth.
A same-origin proof-bearing POST starts the supported protocol flow and establishes transaction-specific browser correlation.
Use state, PKCE where supported, nonce/issuer/callback checks and a single conditional callback claimant before code exchange.
The candidate host-only Secure/HttpOnly correlation cookie must match the actual callback mode; a cross-site form POST cannot be assumed to carry a Lax cookie.
Keep the mechanism unenabled until its browser binding is demonstrated; do not weaken correlation to accommodate a failed test.
A safe completion message contains no bearer or provider secret; the initiating client redeems its proof once over POST before the absolute transaction expiry.
Postgres stores transaction/proof/callback state so launch, callback and redemption can land on different API replicas.
Lost opener/proof, failed cookie correlation, denial, expiry or duplicate redemption is a recoverable explicit failure.
Choose finite transaction expiry from actual upstream validity and usable MFA/consent timing, without separate invented redemption clocks or IP/count quotas.
Service handoff pages use no-store, no-referrer, restrictive CSP and no third-party scripts.

Persistent restoration is a required journey with an unverified browser transport, not an already proven cookie shortcut.
The candidate uses protected service-origin restoration state and the same transaction/window mechanism, plus a demonstrated binding to the intended returning client before releasing a bearer.
A cookie plus an arbitrary new initiation proof from any null-origin requester is insufficient restoration authority.
The prototype must prove how the returning client supplies that binding across reload/new tab/return visits under the actual package storage and popup rules; absent such proof, require fresh verified authentication rather than silently exposing a session.
This unresolved transport is D01/E01, not a new approval UI or permission product.
Keep A07's final wire shape dependent on that evidence while implementing the fixed expiry/revocation/identity contract.
Silent-login hardening is conditional prototype work: adopt only a simple transparent solution with no adverse UX, browser/embed or performance impact; otherwise surface the concrete tradeoff before selecting it.
CHIPS support alone does not prove Tableau embedding or returning-client binding, and browser ancestry APIs are not assumed to establish package identity.
No new approval screen or Tableau feature dependency is selected, and this specification task authorizes no live auth prototype.
Bundle SDK assets for the actual package and test its opaque-origin network, popup and CSP prerequisites on Cloud and Server.
Discard identity-provider tokens after verification unless a supported validation step requires short-lived encrypted retention.

## App and connection policy

App configuration contains an ID, enabled state, provider/default selections and safe transport configuration.
Static registration determines which protocols/capabilities exist; it is not a per-app feature-permission system.
A configured app ID does not prove who authored a package, and changing it cannot change the verified owner or broaden a shared audience.
Personal access checks owner equality in verified deployment/site scope across configured apps, with no personal app-use row or additional consent for a second app.
Connection discovery lists the owner's compatible connections and explicitly available operator-shared connections; defaults never hide an account substitution.
An operator connection audience enumerates verified deployment/site entries and, where narrower, stable users within them.
An all-users audience is explicit for named verified sites, never implicitly every site registered later.
A viewer may use permitted native operations under the provider account's permissions but cannot manage operator secrets/audiences.
Only the personal owner may reauthorize, replace or disconnect their personal connection.
Current session/site/provider/configuration and shared-audience checks precede new operations; [disclosure](#disclosure-and-trust-boundary) is separate from provider usability.
App disablement removes that configuration entry from new use; personal ownership does not become app-specific as a consequence.

## Trusted site registry administration

Access owns unique `(deploymentId, siteId)` entries with opaque internal ID, enabled state and safe creation/update attribution.
A deployment has an immutable internal ID, `cloud` or `server` kind, selected identity adapter and operator-approved canonical URL/aliases.
The registry interface accepts a configured deployment ID and stable site ID; it cannot configure arbitrary issuers, perform caller-directed discovery or establish deployment continuity.
This is the specific correction to the old Cloud-URL identity pair needed for both platforms; the enrollment integration and its authority remain unchanged.
Site registration records admission policy, not proof that the enrollment caller owns the site.
All verified users of an enabled site pass eligibility regardless of email, without personal or per-app enrollment.

The protected enrollment backend uses a separately provisioned registry-management credential limited to listing/registering/enabling/disabling sites.
Reuse high-entropy secret verifier primitives with a distinct management role; ordinary browser/provider credentials fail here, and registry credentials cannot impersonate viewers or access provider data.
The external integration authenticates its administrators; forwarded email/actor text does not grant authority.
No new enrollment gate, webpage or general admin product is introduced.

| Operation | Contract |
| --- | --- |
| `GET /v1/admin/tableau-sites` | Registry-only bounded keyset listing of safe identity/state. |
| `POST /v1/admin/tableau-sites` | Validated deployment ID/site ID; 201 new, 200 existing without implicit re-enable. |
| `PATCH /v1/admin/tableau-sites/:id` | Enabled boolean only; identity fields are immutable. |

A mistaken deployment/site pair is corrected by adding the right pair and disabling the wrong one, without migrating private data.
A controlled deployment URL alias update is separate operator configuration and requires continuity evidence before preserving identity.
Persist actor/time/target/state-change metadata atomically with the mutation; no separate audit platform or log-sink dependency is required.
Site mutations and transactional authority checks use the parent site lock; ordinary requests use the coherent read-only snapshot boundary, so disablement committed before that snapshot denies without a stale allow cache.
Disablement denies new sessions/restoration, site-bound starts/checkouts and private/event disclosure, while already-started work keeps its original outcome rules.
Re-enablement restores eligibility only, not expired/revoked sessions or absent shared audience membership.
Independent source setup under operator authority is not impersonation of the last viewer to use a shared account.

## Connection selection and state

A connection has immutable provider/owner association, state, authority generation, credential generation, explicit connector-reauthentication time, safe account display and protected validated runtime context.
Store stable provider-account evidence only when required for continuity, routing or safe display; names/emails alone are not continuity proof.

| Mode | Setup and use |
| --- | --- |
| No credentials | Enabled public provider mode still requires service identity; reject irrelevant connection selection and apply no connector consent clock. |
| Personal OAuth | Owner initiates supported authorization; code exchange and storage remain server-side. |
| Personal static/API key | Owner submits declared secret input over an authenticated protected POST, validates provider evidence and atomically publishes; no fabricated OAuth redirect. |
| Operator OAuth/static | Protected operator action runs the shared flow/import with explicit shared audience; viewers cannot provision or modify its secrets. |
| Derived credentials | Server derives scoped material from a current base bundle with documented audience/expiry/regeneration; inherit the base authority and explicit reauth clock. |

Selection never falls back between modes or searches globally by provider email.
Unknown and non-visible connection IDs have the same public outcome.
States are `active`, `reauthorization-required`, `renewal-uncertain` and `disconnected`; expiry is data rather than an owner change.
The existing `renewal-uncertain` wire state covers uncertainty from any possibly invalidating setup, import or renewal; it never means that old material is safe to use.
A temporary provider error does not reassign the account, and disconnect is terminal for that connection ID.

### Reauthorization and generations

Configure a connector interval only when operator policy selects one; unset means no invented periodic deadline, while provider expiry/revocation still applies.
When set, derive freshness from the last successful deliberate verified authorization/import, never from refresh or use.
New interactive provider work, admission and queued first starts require freshness; retained-result reads and already-started work follow their separate contracts.
Same-account reauthentication preserves authority generation when stable provider subject and known client/destination/grant continuity support it, while publishing a new credential generation and explicit reauth time.
Do not mirror provider ACLs; desired configuration scopes do not prove granted permissions.
If identity/authority continuity is unknown, incompatible or different, require explicit replacement and advance authority generation; old jobs cannot inherit that account.
Queued jobs blocked only by freshness remain visible and can start after proven same-account reauth; permanently replaced/disconnected generations fail promptly without retargeting.
Derived credentials never outlive changed base authority and do not reset deliberate reauth.
For static credentials, a provider-supported validated reimport/reconfirmation can establish explicit reauth; unsupported verification remains explicit rather than inventing a timestamp.

## Connection runtime context

Provider declarations specify required inputs/context, validation, acquisition from setup/authorization or narrow authenticated discovery, and preservation/replacement on renewal.
Fixed-host providers need no discovery; failed optional context must not block unrelated supported fixed-host endpoints.
Credential-bearing metadata is entrusted secret material, kept encrypted with the credential bundle rather than exported as display data.
Validate context-derived destinations through the same recipient policy as configured endpoints.
Publish credentials, required validated context, safe metadata and optional account evidence as one versioned bundle.
A request cannot combine credentials from one generation/account with a destination cached from another.
No readiness for an affected endpoint is advertised until required discovery succeeds.

A new setup failure discards unpublished material and fails the attempt; a safe bounded discovery retry may use its still-live attempt where provider semantics allow.
A replacement denial normally preserves the committed bundle, but not a claim that old credentials remain usable after a potentially invalidating provider rotation/exchange.
If setup/import/renewal may have invalidated old material and required discovery then fails, apply [revision-scoped recovery](#competing-credential-mutations) to that exact expected bundle and fence late publication.
Documented provider recovery or a proven independent explicit replacement resolves uncertainty; do not silently restore old tokens or mark an unrelated newer bundle unusable.
Retire connection-specific event routing on disconnect/account replacement, with source revisions fencing late hook results.
Provider-wide sources retain their separate setup owner and do not follow browser lifetime.

## Competing credential mutations

Credentials owns one durable mutation reservation per existing connection, shared by setup/reauthorization, static import and renewal across all API/worker replicas.
Connections owns the user-facing setup transaction and calls this same arbitration boundary; a per-transaction callback claim alone never authorizes bundle replacement.
At existing-connection setup/import begin, atomically check current owner/operator authority and the caller's expected authority generation, capture the server's exact `(authorityGeneration, credentialGeneration)` bundle revision, and reserve the connection for that logical operation.
A second setup/import receives 409 `credential-mutation-in-progress` before any provider launch/exchange; a renewal contender waits only within its operation deadline, releasing database connections between waits, then rereads or reports unavailable.
A setup racing an already reserved renewal gets the same conflict and may be explicitly begun again after the operation settles; no hidden setup queue, automatic consent retry or revision rebasing exists.
The reservation is a correctness boundary, not a usage quota or a database lock held during consent.

One Credentials mutation representation records an opaque ID, kind, operation reference, immutable expected bundle revision, absolute expiry, processor token/incarnation/lease and dispatch/recovery phase.
Prefer connection-owned fields for an existing connection; setup keeps browser/protocol correlation plus this reference, and renewal has no duplicate attempt authority.
A new-connection setup uses the same representation attached to the setup transaction until first publication; it does not need an existing-connection exclusion lock.
Setup reservations expire no later than the setup transaction; renewal uses its bounded operation lifetime.
A passive browser wait retains this bounded logical reservation without holding a database connection or occupying a worker execution slot.
Each active launch/exchange/import-validation/discovery step uses a random processor token, process incarnation and lease, with the reservation/attempt expiry also checked using fresh database wall time after locks.
An explicit transition to waiting for a browser callback releases that processor claim while retaining the same reservation; another API can continue the verified protocol transaction with a fresh claimant.
Lease expiry is not such a handoff and cannot authorize replay or resumption of an uncertain external step.

Before any provider interaction, commit its `may-have-dispatched` phase and whether that step can invalidate the expected bundle.
Possible invalidation is cumulative for the reservation: later read-only discovery or a browser-wait transition cannot clear an earlier possibly invalidating dispatch.
The provider declaration must identify the earliest potentially invalidating step, including authorization launch if applicable; unknown invalidation behavior is treated as possibly invalidating.
Once such a step is dispatched, deny new checkout of the expected bundle until an eligible complete bundle is published or documented evidence proves it remains usable.
Earlier released snapshots cannot be recalled; ordinary read-only discovery and local encryption remain outside database locks and do not create a second mutation owner.
For a local-only static import there is no external-dispatch uncertainty, but validation/publication still uses the same reservation and exact revision fence.
If static validation or setup can mutate remote credentials, it follows the same dispatch rule as OAuth/renewal.

Only the current mutation owner and live processor may atomically publish credentials, required context, safe metadata and setup/renewal completion.
The final predicate includes mutation ID, expected bundle pair, operation/attempt state and expiry, processor token/incarnation/live lease, current provider/connection authority and required discovery success.
Setup/import additionally requires its initiating live session/owner or operator authority; renewal uses the applicable ConnectionUse and operation claim, preserving the already-started job exception to ordinary session/connector freshness expiry.
Compare the current stored pair to the immutable expected pair before assigning the next credential generation; never substitute the newest revision into an older attempt.
Successful deliberate setup/import always advances credential generation, even when revalidation returns identical bytes; proven same-account continuity can preserve authority generation and update explicit connector-reauth time.
Only this successful publication releases the reservation as ready; zero-row publication is stale, not success.
New-connection setup remains single-attempt-bound and creates its first bundle atomically, without claiming an existing connection's mutation reservation.

| Interruption or conflict | Revision-scoped recovery |
| --- | --- |
| Cancel/expiry/crash before external dispatch | Fence the processor and finish the setup/renewal attempt; conditionally release its reservation, leaving the exact existing bundle unchanged. |
| Dispatched step proven unable to invalidate the old bundle | Never replay the uncertain code/request; fail the interrupted attempt and release only its own reservation while preserving the committed bundle. |
| Possibly invalidating dispatch, lost response, required discovery failure or expired active claim | Fence the processor and terminate ordinary setup/renewal publication; mark only the still-matching expected bundle `renewal-uncertain` and unusable, retaining an uncertainty barrier instead of freeing automatic renewal. |
| Expected pair or mutation owner no longer current | Treat recovery as stale; do not overwrite, clear or poison a newer bundle/reservation, and never revive disconnected authority. |

Cancellation/session expiry after possible invalidating dispatch cannot merely fail the setup and leave its expected old bundle advertised as active.
The uncertain barrier has no executing owner and holds no lease, slot or database connection; bounded recovery scans record attention, never repeat the external mutation because a lease expired.
Before an explicit setup/replacement may supersede that barrier, provider evidence must establish safe resolution of the old operation or independence of the new grant/material from any delayed old effect.
Record that bounded recovery/independence evidence and fence the old mutation under the connection lock before reserving the new operation; elapsed time, a new login or a different local token alone is not evidence.
A successfully published newer independent bundle remains usable when an old finalizer/recovery scan arrives because both old mutation ownership and expected revision fail.
If independence cannot be established, keep the affected connection unusable and require provider-supported recovery rather than risking another overlapping mutation.
Disconnect/replacement/configuration retirement uses the same connection lock to fence reservations; only a supported new authority/bundle can become ready afterward.
No generic business receipt, global lock or additional queue is introduced.

## Provider authorization transaction

Begin from the current owner/operator authority, provider registration, declared inputs and explicit optional replacement intent plus expected authority generation.
Input cannot choose an owner, client secret, arbitrary token/callback endpoint or shared identity.
Use the shared handoff and maintained protocol implementation, preserving initiating session/owner, app attribution, expiry, protected state/verifier, grant request and replacement generation.
For an existing connection, setup/import stores the mutation reference captured by [Credentials arbitration](#competing-credential-mutations); the exact expected pair and processor authority remain owned once there, never supplied by browser JSON or rebased.
Ordinary access renewal keeps the same session and valid attempt; true session revocation/expiry or attempt expiry ends it, and a new login cannot revive a terminal attempt.
The verified callback consumes protocol correlation and claims the shared mutation processor in the same transition, without a second setup lease.
One conditional callback claim changes `pending` to `exchanging` before exchange; only its live claimant can publish `succeeded`, also requiring the current mutation reservation and matching expected bundle for an existing connection.
Other terminal attempt states are `failed`, `cancelled` and `expired` and cannot return to pending.
Recheck current authority and, for an existing connection, the exact expected bundle/reservation before exchange and before atomic bundle/connection/attempt publication.
Record possible dispatch before exchange or any earlier potentially invalidating launch; interrupted `exchanging` recovery follows the same revision-scoped rules as renewal.
Copied locators, swapped state/issuer/callback, wrong-browser completion, concurrent claims and stale replacement cannot attach credentials.
The owner may deliberately choose a different external account; if stable identity is unavailable, require explicit replacement intent and do not claim continuity.
Provider denial preserves existing state only when supported evidence rules out invalidation; ambiguous possibly invalidating outcomes use the exact expected-bundle recovery contract.
Lost exchange responses may have consumed the code; do not replay automatically or report uncommitted setup as ready.
Cancellation prevents attachment without promising revocation of an uncommitted remote grant; possible old-bundle invalidation still requires revision-scoped recovery, and no staged consent-resume workflow is added.
Return safe status/connection ID only after commit; popup closure is not success.

## Credential variants and confidentiality

Use the shared [authenticated encryption adapter](persistence-operations.md#encryption-and-maintenance-replacement), with protected host keys and record/generation binding.
Browser views, logs, jobs and events never expose entrusted or helper-derived authenticators, even when provider metadata labels them context.
Native provider-created credentials deliberately returned by a permitted operation are legitimate private result data, not automatically entrusted credentials.
They can remain usable externally after service expiry/disconnect; no generic scanning, provider feature ban or additional approval follows.
A known endpoint that retrieves this service's actual entrusted authenticator requires a narrow documented block or verified field filter before disclosure.

| Credential property | Shared lifecycle |
| --- | --- |
| Known expiry | Refresh through supported renewal or require explicit reauthorization. |
| Non-expiring | Use until rejection, replacement or disconnect; invent no refresh. |
| Unknown expiry | Declare supported validation-on-use behavior or explicit unsupported status. |
| Renewable/rotating | Declare replacement/omission semantics and ambiguity recovery; omitted refresh token is not deletion unless documented. |
| Static/imported | Protected owner/operator setup, supported validation and explicit replacement. |
| Derived | Bind base generation, recipient/permissions and expiry; regenerate only under current base authority. |

## Refresh coordination and interruption

Credentials coordinates renewal through the same [per-connection mutation reservation](#competing-credential-mutations) as existing-connection setup/import across all API/worker replicas.
No Redis lock or in-process mutex supplies authority.
Renewal uses that mutation's processor token, incarnation, expected pair, expiry, lease and `claimed` or `may-have-dispatched` phase rather than another renewal record.
Claim under ordered connection/mutation locks only when the shared owner is free, after rereading the current bundle; another setup or renewal may already have replaced it.
Other callers release database connections between bounded waits and reread usable state, without independently rotating the same revision.
When request preparation is complete against the expected pair, combine reserve/claim and dispatch in one transaction that checks current authority/revision and commits `may-have-dispatched` before sending.
Otherwise retain a separate dispatch transaction checking the same live processor and exact pair; reducing interactions cannot skip the invalidation marker.
No authority lock is held through provider I/O, discovery, validation or encryption.
Publish the complete encrypted credential/context bundle only under the same current reservation/live attempt, matching expected generations and valid current authority; increment credential generation atomically and clear that mutation owner.
Return the newly published coherent snapshot and safe state from the publication transaction under its current-authority checks, avoiding an immediate duplicate fetch.
A temporarily unusable expected bundle during the owner's own potentially invalidating dispatch does not revoke that owner's conditional publication authority.
Zero-row conditional publication is explicitly stale and never successful.
For job/source-triggered renewal, dispatch and publication also respect the applicable live operation authority/deadline; if fencing loses a possibly rotated bundle, preserve uncertainty rather than declaring old material safe.

An expired undispatched `claimed` attempt can be fenced and its reservation released because the old claimant cannot pass the dispatch predicate.
An expired possibly invalidating dispatched attempt marks only its matching expected bundle `renewal-uncertain`, retains the uncertainty barrier, invalidates its token and rejects late success; a stale finalizer cannot poison a newer independent bundle.
Lost rotation responses or rotation followed by failed required discovery cannot cause blind old-token reuse.
Only documented provider-safe recovery or proven independent explicit setup can replace the uncertainty barrier with a new fenced attempt; explicit reauthorization alone does not prove that a delayed old effect is harmless.
A definite safe transient failure may be retried only under supported renewal semantics; unrecognized transport ambiguity is uncertain.
Select finite request/discovery/lease timings from provider and host evidence with dispatch/cleanup fitting the lease, without fixed speculative defaults.
Renewal markers are a narrow credential-safety mechanism, not a general business-dispatch ledger or permission to replay the original proxy request.

## Disconnect, checkout, and active work

Disconnect commits an unusable state, advances authority generation, fences the current mutation reservation and all renewal/setup/import claims, retires connection-specific routing and removes usable stored authenticators.
It does not indiscriminately invalidate original execution/result claims.
A previously authorized scoped checkout may dispatch after disconnect because its read snapshot or background transaction and remote send cannot be atomic; no instantaneous remote cutoff is promised.
Every later checkout rechecks current connection authority and the applicable live operation claim/deadline.
Ordinary A18/A39 use the [coherent request snapshot](persistence-operations.md#ordinary-request-snapshots), with no policy shared-lock commit or writes when the bundle is usable.
An ordinary capability is request-bound: later helper calls require a current session and connector freshness, unlike the explicit started-Job exception below.
Best-effort remote revocation may use a narrowly scoped transient cleanup copy from the disconnect operation, then dispose it; no retained secret or retry queue exists to finish jobs.
Report confirmed/unsupported/unconfirmed remote revocation honestly.

A started job can continue after ordinary session/connector freshness expiry under original account and current connection authority, without renewing interactive access or authorizing new work.
Disconnect/replacement blocks new provider checkout; it need not cancel already-dispatched work or prevent an eligible original result/callback that needs no new credentials.
[Jobs](providers-execution.md#interruption-external-tasks-and-cancellation) fences obsolete claims, deadlines and terminal races independently of provider usability.
Trusted code is not sandboxed and must not retain credentials outside the operation or bypass the shared lifecycle.

## Disclosure and trust boundary

Personal jobs/results require current service session, enabled verified site and submitter-owner equality, independently of the current app attribution or provider connection usability.
Operator-shared work additionally requires the current explicit shared audience; no-credential work requires the original submitter's current verified scope.
The same resource authorization governs job listing, status, cancellation requests and job notifications; knowing an ID is insufficient.
After provider disconnect, eligible owners can read retained results without checkout, new provider calls or restored secrets.
Authorize the immutable payload reference before loading and recheck current disclosure/retention before logical release, without holding locks through decryption or network drain.
No check can recall bytes already released.
Operators and statically installed service code remain trusted; browser code can exercise only the verified user's personal or explicit shared authority.
Future identity/credential protocols extend these owned interfaces rather than adding a backend-consumer broker or permission platform.
