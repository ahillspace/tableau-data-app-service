# Targeted independent Astra confirmation

Status: R1-R4 are closed at the specification level; no material residual counterexample was found in the corrected flows.
This establishes bounded document-level convergence for the independent review findings, not user acceptance or verified application behavior.

## Exact reviewed source

Canonical source commit: `19f3bc05d9a79ce231f5c69686149c045f78c568`.
Reviewed working-tree HEAD: `10ae83b173d1de8bd0fbfa16cf1f65bb58f754ba`, containing subsequent review evidence only.
The canonical source paths had no diff from the identified source commit.
Reviewed aggregate SHA-256: `8c7295bda7142bd496879dad8d18ac514dd70600c817d60145183d26841049e0`.
The [revised manifest](astra-revised-source.json) verified with `matches: true` and no structural errors.
The unchanged independent initial snapshot also verified against its original aggregate `ec1f79e438f6b5dbbef97e927b7bba68d44583c0cb87b5fd7ab955224992e3ab`.

This pass read the current canonical source, [author disposition](astra-revision-disposition.md), and the [independent findings](astra-initial-independent-review.md).
It did not read historical mixed-model drafts or reopen the broader architecture exercise.
No canonical source was changed.

## Finding outcomes

### R1 - Authorization landing authority: closed

The [connection contract](../specs/access-connections.md#authorization-transaction) now separates `begin`, the inert landing locator, authenticated `launch`, and the provider callback.
Launch must prove the transaction's original app/holder and current recovery generation and revalidate the initiating authority before creating browser correlation or issuing a provider redirect.
Consequently, transferring A's locator to B cannot attach B's account to A through URL possession alone.
The correlation secret is server-generated, delivered only through the HTTP cookie response, and stored as transaction-specific digest/expiry; concurrent flows no longer depend on one replaceable global cookie.
Repeated launch cannot transfer the transaction to a new browser.

The shared `ConnectionService.launch` interface, server-only `AuthorizationLaunch`, [HTTP routes and SDK flow](../specs/events-http-sdk.md#http-surface), and [verification scenarios](../verification.md#cross-module-failure-checks) agree on this ordering.
A legitimate popup or top-level flow must obtain same-holder proof through the selected adapter; a combination that cannot do so is explicitly unavailable.
That remaining transport/browser dependency is candidly deferred and does not weaken the required domain check.

### R2 - Restore authority and history barrier: closed

The [restore contract](../specs/persistence-operations.md#restore-barrier-and-history-generations) now requires an operator-controlled generation and gate outside database backups, with a database initialization marker and fail-closed mismatch handling.
The gate covers private reads, authorization launch/completion, command/event admission and outbound work.
Restored credentials remain quarantined, and old records are not silently relabeled as current.
Reopening requires explicit review of current policy, source associations and the missing-write interval; new delegated/service connections require deliberate authorization or provisioning.

The generation appears in shared access and connection-use contracts and is checked by command windows, receipt references, provider cursors and feed cursors.
Under fresh access, old receipts/windows produce expired-history handling, old provider cursors expire, and old feed cursors require resynchronization without private disclosure.
The original disconnected-connection, lost-write-tombstone and position-100/counter-90 counterexamples therefore have explicit rejection points in the [revised walkthrough](../verification.md#restore-across-stale-authority-and-history).
The design also correctly limits its guarantee: it requires the operator's restore procedure and cannot detect deliberate bypass from an internally consistent stale database alone.

### R3 - Private and public pagination seam: closed

The [shared handler contracts](../specs/contracts.md#owner-interfaces) and [pagination specification](../specs/providers-execution.md#private-pagination-seam) define both directions of the conversion.
Public paging is a separate command envelope; execution validates the base query and public cursor, then passes only page size and private continuation to the handler.
The handler returns items and private continuation; execution bounds that continuation, applies the authority/query/connection/generation bindings, creates the opaque public cursor, and validates the completed public page before persistence or serialization.

The stable query digest explicitly excludes the changing cursor and command window, while the command digest includes page size and the supplied public cursor.
This permits the next page under a new command identity while rejecting reuse of one request key for a different page.
Read-only pagination, non-paginated rejection, handler-supplied public-cursor rejection and the [two-page walkthrough](../verification.md#private-pagination) agree across the interfaces.
A second provider needs only its own continuation interpretation, with no new access or cursor cryptography responsibility.

### R4 - Retention metadata and complete response loss: closed

Discovery now supplies a signed, owner-scoped command window before submission, and every admitted result or inspection contains receipt timing metadata.
The [shared wire/domain shapes](../specs/contracts.md#commands-and-results), [admission and retention rules](../specs/providers-execution.md#command-windows-and-result-retention), and [SDK recovery behavior](../specs/events-http-sdk.md#browser-sdk) consistently preserve the original window/key pair.
The original admission deadline is enforced transactionally; duplicate lookup remains available through its distinct history deadline, while an expired original window cannot create work after tombstone deletion.
Read-only lookup explicitly distinguishes currently unrecorded commands from expired history and does not infer safe resubmission from absence.

The SDK retains the token and timing metadata before dispatch, uses lookup after a wholly lost response, and permits only identical same-window/key resubmission while original admission remains open.
Unknown metadata, elapsed admission, history expiry or recovery-generation change cannot cause an automatic replacement window/key for the old write.
The [response-loss walkthrough](../verification.md#complete-write-response-loss-and-retention) covers output expiry separately from history expiry and leads to reconciliation when history is no longer available.
Window issuance covers execution/output bounds, configuration changes cannot shorten issued promises, and signing-key rotation retains verification through the supported history interval.

## Bounded regression check and evidence limits

The changes preserve no-credential and explicitly configured service execution without requiring a holder or personal authorization flow.
Binding-owned command windows retain their owner discriminator even if subsequent access also supplies a holder, avoiding an ownership change during response recovery.
The launch, cursor and recovery checks preserve fixed execution identity, current-authority checks, finite retention and explicit uncertain-write behavior.
The corrected event/resync contract remains an authenticated feed with explicit subscriptions and a compatible authoritative read; it does not introduce capability execution from events or a workflow engine.
The additional signed window, private continuation envelope and external recovery record each serve the reviewed counterexample without adding a deployment service or account system.

No material residual counterexample or directly caused design regression requires another substantive review round for R1-R4.
This pass performed document inspection, scenario reasoning, source-diff confirmation and manifest verification only.
No application, Postgres concurrency, cryptographic library integration, browser flow, provider behavior, restore drill or runtime test was executed.
The front-door transport, real-provider compatibility, numerical operational configuration, user acceptance and subsequent implementation evidence remain outstanding as already declared in the canonical design.
