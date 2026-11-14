# Independent Astra review of the initial design

Status: independent specification review complete; four bounded findings require architecture-owner disposition.
Reviewed aggregate SHA-256: `ec1f79e438f6b5dbbef97e927b7bba68d44583c0cb87b5fd7ab955224992e3ab`.
The reviewed file set is the nine Markdown files recorded in [astra-initial-frozen.json](astra-initial-frozen.json), under [design/astra-initial](../design/astra-initial/architecture.md).
The snapshot verification command returned `matches: true` with no structural errors before review.

The reviewer prepared [independent criteria](astra-review-criteria.md) from `AGENTS.md` and `GOALS.md` before reading this design.
No older product architecture, specification, decision, or review document was read.
The evidence here is source-document inspection and concrete scenario walkthroughs, not passing runtime tests, browser tests, provider tests, user acceptance, or implementation verification.

## Assessment

The proposed application shape fits the goal baseline: one application and database, trusted static modules, explicit none/service/delegated identity, no local human directory, bounded inline execution, and honest uncertain outcomes.
Connection ownership is separate from external subject identity, service connections require explicit app bindings, and deferred front-door transport is not used as permission to trust public identifiers.
Durable renewal evidence, invocation receipts, event deduplication, and feed ordering each have a concrete correctness purpose; the draft does not import an unnecessary orchestration platform.

The remaining findings concern missing cross-module obligations and two incomplete client/recovery contracts.
They do not call for another service, an account platform, a job runner, or a complete production front door.
P1 means the safety contract must be made unambiguous before it is used as an implementation baseline.
P2 means a shared interface decision is missing and must be resolved before implementing that flow.

## R1 - P1: Bind the authorization landing to authority established before the link is transferred

Affected contract: [authorization transaction](../design/astra-initial/specs/access-connections.md#authorization-transaction), especially lines 77-107, and [browser connection flow](../design/astra-initial/specs/events-http-sdk.md#browser-sdk), lines 105-109.

The transaction records the initiating authority, but the specified landing page creates browser correlation before redirecting to the provider without saying how that landing proves it is running for the same initiating holder.
Checking the newly created correlation cookie on callback proves continuity from that landing onward; it does not by itself bind the browser to the authority that called `begin`.
The authorization landing is also absent from the HTTP surface, so its access-verification obligation cannot be inferred from the listed route contracts.

Concrete counterexample: holder A legitimately starts an authorization transaction, sends its returned authorization URL to person B, and B opens it in a different browser.
If the landing assigns B a fresh valid correlation cookie using the URL alone, B can authorize B's external account and satisfy every explicitly listed callback check.
The completion then publishes B's credentials under the transaction's still-valid holder A association, allowing A to use them.
Rechecking A's stored authority at completion does not detect this substitution.
This is an unresolved contract ambiguity, not a claim that an implementation has been exploited.

Necessary correction: explicitly require the landing to prove the same app and holder association as `begin`, or verify browser-bound initiation evidence established before an authorization URL can be transferred.
A transaction URL alone must not be allowed to establish that proof on whichever browser first opens it.
Specify who creates, checks, and expires this evidence, and define how the popup or top-level return variant preserves it.
The front-door transport can remain deferred; the equality and browser-binding obligation cannot.

Required design check: start as A, open the returned URL in B's browser, and show the exact check that prevents credentials from being attached to A.
Also trace a legitimate new popup and two concurrent legitimate authorization transactions so the correction does not accidentally require a general login or a single global correlation slot.
This finding follows existing delegated-ownership requirements; it adds no new account or onboarding requirement.

## R2 - P1: The restore barrier covers outbound work but leaves stale authority and cursor histories usable

Affected contracts: [restore posture](../design/astra-initial/specs/persistence-operations.md), lines 53-56; [feed cursors](../design/astra-initial/specs/events-http-sdk.md#feed-and-resynchronization), lines 50-66; [receipt retention](../design/astra-initial/specs/providers-execution.md#result-retention-and-paging), lines 124-129.

The proposed safe restore posture disables outbound execution until reconciliation and establishes a new command-retention boundary.
It does not say whether restored connection state may authorize private receipt/feed reads or authorization completion during that interval.
It also defines no way to distinguish a cursor or command from the discarded history once processing resumes.
The warning that restore is not transparent is appropriate, but it does not make the specified partial barrier sufficient.

Concrete counterexample: a backup contains an active delegated connection that was subsequently disconnected, plus private feed rows or retained results.
After restore, a still-valid holder binding can see the restored active connection and pass the stated current-policy checks for disclosure, even while outbound execution is disabled.
For the feed, a client holding an unexpired cursor at position 100 can reconnect after the database counter was restored to 90.
New accepted events numbered 91-100 are then behind that cursor and can be skipped without any configured expiry having occurred.
Likewise, a write completed after the backup can lose its command tombstone; an old command resubmitted after outbound re-enablement can become a new write unless the new retention boundary is enforceable at admission.

Necessary correction: define the minimum recovery barrier across authorization completion, connection-based disclosure, outbound dispatch, command admission, and both kinds of cursor.
State how pre-restore authority and history references become unusable, and how clients receive a resync or expired-history result instead of silently continuing.
The owner may choose a recovery generation checked by these boundaries, verified external invalidation, or a sufficiently conservative closed period; the chosen method must not rely solely on state that is itself restored from the stale backup.
Keep the detailed backup policy and production runbook deferred if desired, but specify the invariant that permits reopening.

Required design check: restore before a disconnect, before a completed write, and before an acknowledged feed position, then trace rejection and deliberate recovery for each retained client reference.
This corrects the safety of a recommended recovery posture; it does not require transparent restore or exactly-once external effects.

## R3 - P2: Pagination has no defined boundary between private provider continuation and public service cursor

Affected contracts: [capability definition and context](../design/astra-initial/specs/contracts.md), lines 64-85 and 175-186; [paging behavior](../design/astra-initial/specs/providers-execution.md#result-retention-and-paging), lines 131-137.

The design requires the browser to receive only a service-owned opaque cursor bound to access, query, resolved connection, epoch, page size, and expiry.
The capability handler is asked to translate provider continuation, but its declared context contains only invocation ID, signal, deadline, and `request`.
Neither the invocation contract nor a handler-side paging result defines how continuation enters or leaves the shared cursor owner.
The public `Page<T>.nextCursor` cannot simultaneously mean a private provider token and an already-protected service cursor without an explicit conversion boundary.

Concrete counterexample: the synthetic provider returns a private next-page token after a delegated read.
The handler can return that token as `nextCursor`, but doing so leaks provider continuation and bypasses the required binding.
Alternatively, it must obtain access and connection internals or implement its own cursor envelope, contradicting the stated narrow handler context and shared infrastructure ownership.
On the next invocation, the generic execution service has no documented paging input field or helper through which to validate the public cursor and provide its decoded provider continuation to the handler.

Necessary correction: select one explicit seam for pagination.
For example, define a public paging request/result envelope and a separate handler-side continuation value that the core validates, unwraps, binds, and wraps, or provide narrow cursor helpers that retain all authority and encryption ownership in the core.
Specify which fields contribute to the stable query digest, excluding the changing cursor, and whether input/output validation occurs before or after public/private conversion.
A second provider must implement only its continuation interpretation without knowing app, holder, connection-epoch, or encryption details.

Required design check: trace one page and its next page through the SDK, HTTP validation, cursor owner, handler and response validation, then substitute another holder, query, page size and connection epoch.
This is a missing shared interface for an existing acceptance scenario, not a request for a paging framework or provider snapshot guarantee.

## R4 - P2: The SDK's write-retention rule cannot be implemented from the declared wire results

Affected contracts: [invocation results and receipts](../design/astra-initial/specs/contracts.md#commands-and-results), lines 129-141; [result retention](../design/astra-initial/specs/providers-execution.md#result-retention-and-paging), lines 124-129; [HTTP inspection and SDK recovery](../design/astra-initial/specs/events-http-sdk.md), lines 76-78 and 100-112.

The text requires the receipt to advertise output availability and requires the SDK to stop retrying writes beyond the advertised command-retention horizon.
The public `InvocationResult` has neither horizon, while the separate `InvocationReceipt` has only optional output availability and is not returned by the declared `inspect` interface.
No discovery field, response header contract, or lookup result specifies the command-retention boundary.
Choosing the eventual retention duration is a legitimate operational decision; exposing the information and defining its recovery meaning are shared contract decisions.

Concrete counterexample: a write is accepted but its entire response is lost.
The client retains its request key and later receives `not-found` from by-key inspection after the tombstone was deleted.
The current client contract cannot distinguish that history loss from a command that was never accepted, nor calculate when its promised duplicate suppression ended.
A resubmission using even the same key can therefore create a new write after the service has deliberately forgotten the old one.
The prose forbids the SDK from doing this, but supplies no implementable information for enforcing the rule.

Necessary correction: define how clients learn the supported command window and output window, including when the first response is lost, and make the relevant metadata part of an actual result, inspection or discovery contract.
Specify the SDK action when the horizon is unknown or exceeded and distinguish safe result lookup from permission to resubmit an uncertain write.
Do not require indefinite tombstones or promise duplicate suppression after expiry.

Required design check: lose the complete initial response, recover within the supported window, expire only the output, then expire the command history and attempt recovery again.
The last case must lead to an explicit old/unknown-history state or documented manual reconciliation, never an inferred permission to retry the write.

## Intentional deferrals and non-findings

The selected access transport, app onboarding, durable holder continuity, tested Tableau/browser matrix, first real provider, and numerical operational limits remain explicit external decisions.
None is treated here as a requirement to build a login system or finish deployment design.
The optional reconciliation hook, absence of a durable revocation queue, live pagination limitations, and non-resumable inline handlers are candid limitations rather than hidden guarantees.
The chosen event counter lock and durable dispatch markers are proportional coordination mechanisms for the stated ordering and ambiguity requirements.
Ordinary schema-library choice, module naming, branded IDs, repository layouts, and concrete migration shapes can remain implementation decisions.

## Next review boundary

The architecture owner should resolve R1-R4 in a revised draft while preserving this reviewed snapshot.
The next independent pass should verify only the corrections and their effects on the connected contracts and acceptance scenarios.
A clean targeted pass would establish document-level convergence for these findings, while user acceptance and runtime evidence remain outstanding.
