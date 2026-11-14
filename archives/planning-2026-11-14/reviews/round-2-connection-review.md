# Round 2 connection and cross-component review

Reviewed frozen source commit `18c0b14` with manifest snapshot SHA-256 `a07704ab68ce1617d5c21c22fff2d3f0de9128e533d4b1a76b834bdbfa271e28`.

The findings below identify contract gaps that can cause stale authority, lost or duplicated work, or incompatible implementations, with concrete corrections for R2.

## Findings

### P1: Database restore can resurrect a disconnected credential

`specs/connections.md:59-60,319-320` says a restored snapshot relies on a current connection-state check and key availability, but the restored database itself can be stale.

For example, a backup contains a delegated connection in `ready` at revision 4, the owner later disconnects and the live database records revision 5, and an operator restores the old backup while the encryption key remains available.

The restored `ready` row passes its local current-state check and can reuse the old encrypted token, even though the service had already accepted the disconnect.

Introduce a monotonic restore epoch held outside the database restore boundary and fail closed for credentials, pending attempts, execution-result reads, idempotency replays, cursors, and event cursors created under an older epoch.

Recovery should require explicit operator reconciliation or fresh authorization before delegated credentials can be used again.

### P1: A pending authorization can commit after its app or binding authority is revoked

`specs/core.md:14-18` says disabling an app blocks authorization, while `specs/connections.md:51,99-101,295-301` lets a callback complete a stored pending attempt without recording or rechecking the app revision or current binding authority.

If app A is disabled, or binding X is revoked, after X starts authorization but before the provider redirects back, the pending state remains consumable and can create a `ready` connection under stale authority.

The callback need not receive `TrustedContext`, but its commit must compare the attempt's captured app revision and owner against current app policy and binding status, or disabling/revoking must atomically cancel and fence all affected attempts.

If binding revocation cannot be queried by the callback path, keep delegated completion unavailable until the trusted binding contract provides a revocation check.

### P1: Event high-water marks need commit ordering

`specs/http-sdk-events.md:238-240,276-286` requires transactional inbox/outbox insertion and describes a baseline at the current feed high-water mark, but does not define how that mark orders concurrent commits.

With a normal database sequence, transaction T1 can reserve feed position 41 and stall, transaction T2 can reserve 42 and commit, and resync can return baseline 42 before T1 commits.

When T1 later commits, polling for positions greater than 42 permanently skips its event.

Define a commit-safe per-feed watermark, such as a locked transactional counter advanced with feed insertion or a contiguous committed-position protocol, and test resync against delayed concurrent transactions.

### P1: Ambiguous-write idempotency can disappear while the effect is still unresolved

`specs/execution.md:118-124` recommends retaining execution details and key fingerprints for 30 days, while `specs/http-sdk-events.md:105,115,216` only promises retry protection inside the published retention window.

An `outcome_unknown` write may remain unreconciled when its execution and tombstone retention expires, after which the caller cannot inspect the original resource and the same key may admit a new provider call.

Keep a minimal tombstone and inspectable terminal outcome for unresolved writes until explicit reconciliation, or define a durable operator decision that closes the uncertainty before deleting the record.

The contract should separately state what a retry after ordinary retention and after unresolved `outcome_unknown` retention does, because warning callers about expired protection does not preserve a safe recovery path.

### P1: Event audience has no operator-owned source of truth

`specs/http-sdk-events.md:252-268` requires explicit event-type audiences and subscription revisions, but `specs/contracts.md:25-31` only defines app capability bindings and no event subscription or audience data.

The event adapter can resolve a connection reference at `http-sdk-events.md:234`, but the specs do not define how that connection and normalized event type map to authorized app feeds or which bindings are subscribed.

Add an operator-managed event subscription contract that binds provider event types to app or delegated-binding audiences and revisions, then derive recipients from that policy in the same transaction as inbox and outbox writes.

Without this source of truth, an implementation must guess whether an app-credential event should be broadcast to every binding, delivered to no one, or follow an implicit app-level subscription.

### P2: Logical connection revision and credential version have conflicting semantics

`specs/connections.md:81-89` says public `SafeConnection.revision` changes when the usable credential set changes, but says a refresh-token rotation changes only internal `credentialVersion` at line 83.

`specs/execution.md:96-103` separately captures a credential revision for audit and dispatch fencing, while R1 `ExecutionGrant` at `specs/contracts.md:101-114` carries only one connection `revision` and the connection draft's grant description at `connections.md:87` carries only the logical revision.

Define two named versions with separate meanings: a logical authorization generation for owner, external subject, grant, and policy changes, and a credential version for token replacement and refresh fencing.

Specify how the broker reports or captures credential version for audit without making ordinary refresh invalidate a grant or a previously authorized result, while pinning result disclosure and pagination cursors to the logical generation.

### P2: Delegated authorization is not an end-to-end HTTP or SDK contract

R1 exposes `beginAuthorization(ctx, providerId)` and `readConnection` at `specs/contracts.md:99-110`, but has no `AuthorizationStart` definition, attempt-read method, cancellation method, callback result contract, or reconnect target argument.

`specs/http-sdk-events.md:59-77` omits connection routes and only links to the connection specification, while its SDK type at lines 188-209 has no begin, poll, cancel, or disconnect methods.

The scenario in `specs/scenarios.md:32-37` therefore cannot show how the browser obtains an authorization URL, learns that callback processing completed, safely handles interruption, or reconnects an existing delegated connection.

Add the owner-scoped start, attempt-read, cancel, and disconnect routes plus matching SDK methods, and define a provider callback route that returns only generic status while the original binding polls protected attempt state.

The callback's generic page must not be the only way to read the connection, and `binding continuity` in `scenarios.md:34` must mean correlation to the original server-owned attempt unless a future front door explicitly proves the same browser binding at callback time.

### P2: Cursor pagination is not represented in the domain execution type

`specs/http-sdk-events.md:91-95,194-200` adds top-level `page` controls separate from capability business input, but frozen `ExecutionRequest` and `submit` at `specs/contracts.md:56-60,101-110` have no page field.

The capability entrypoint at `specs/contracts.md:77-88` accepts only `input`, so the execution service has no frozen domain channel for passing page size or an opaque cursor to the provider handler.

Add bounded page controls to the shared execution request and handler context, include them in the idempotency fingerprint, and bind provider cursor resolution to owner, capability, input, page size, logical connection generation, and expiry.

### P2: HTTP Result envelopes and SDK errors do not have one typed behavior

`specs/http-sdk-events.md:47-51` requires HTTP `Result<T>` envelopes, but SDK methods at lines 201-209 return bare data promises and do not define whether service errors are thrown, returned as `Result<T>`, or mapped to a typed SDK exception.

The same document says `ExecutionView.error` is completion data at line 51, while its terminal-state paragraph at line 180 refers to a `FAILED` error semantic that is absent from the frozen `ErrorCode` union in `specs/contracts.md:44-55`.

Choose one SDK contract, such as unwrapping successful `data` and throwing a typed error that retains the full `Problem`, while preserving terminal execution errors inside `ExecutionView`.

Use existing provider-neutral codes for failed executions or add a deliberately defined failure code, and distinguish transport/admission errors from terminal execution state in the SDK types.

### P2: Event deduplication retention is shorter or unknown relative to provider retries

`specs/http-sdk-events.md:234-242` promises duplicate acknowledgement based on a unique provider event key, but the only stated retention is seven days for event records and cursor positions at line 290.

If the provider retries an event after the inbox deduplication row is deleted, the same event can be normalized and enqueued as a new service event.

Declare provider-specific maximum retry ages and retain compact deduplication tombstones at least that long, or keep source-event dedupe keys for a separately reviewed longer retention that is not coupled to feed payload retention.

### P2: Persisted credential and authorization-attempt state machines are incomplete

`specs/connections.md:95-129,183-207` defines connection states and refresh phases but no credential-envelope states such as candidate, active, expired, blocked, revocation-pending, or erased.

This leaves inconsistent recovery choices for a token staged during an in-flight callback, an expired non-refreshable token, an unsafe ambiguous refresh, and encrypted material retained only for remote revocation cleanup.

Define the credential state machine and its atomic transitions alongside connection state, including which states may authorize a provider request and which may only be read by the revocation worker.

The authorization narrative also includes `created -> pending` at `connections.md:123`, but `AuthorizationAttemptState` at lines 250-252 has no `created` member and the initial row is described as immediately `pending` at line 99.

Either define `created` as a persisted state in the pseudotype or state that creation and transition to `pending` are one atomic insert and remove `created` from the state machine.

### P2: Unknown top-level fields can be silently discarded

`specs/http-sdk-events.md:55` says the server strips unknown top-level request properties unless a route schema deliberately rejects them.

A client that sends a misspelled `connectionId`, pagination control, or future security-sensitive selector may receive a different operation's result instead of a validation error, even though the ignored field does not grant authority.

Reject unknown top-level fields on execution, connection, and event request schemas, and reserve stripping only for explicitly documented compatibility fields that cannot change operation meaning.

## Remaining external unknowns

No provider is selected, so event retry horizons, source event ordering, revocation guarantees, refresh-token replay behavior, and provider-side reconciliation remain unknown and must be declared per adapter.

The selected front door and callback deployment are unresolved, so browser continuity, binding revocation checks during authorization callbacks, and Tableau deployment compatibility cannot yet be demonstrated.

The operator key service and restore-epoch storage boundary are unresolved, so backup recovery cannot yet prove that local authority remains current after restoring Postgres.
