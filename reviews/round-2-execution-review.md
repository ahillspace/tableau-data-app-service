# Round 2 adversarial execution and integration review

Status: findings against the frozen round-one proposal, not source edits or user acceptance.

Review snapshot: commit `18c0b14` with aggregate SHA-256 `a07704ab68ce1617d5c21c22fff2d3f0de9128e533d4b1a76b834bdbfa271e28`.

The per-file hashes in `reviews/round-1-frozen-source.json` match the reviewed files, including GOALS, architecture, shared contracts, connections, core, execution, HTTP/SDK/events, and scenario traces.

No implementation, tests, or provider-specific research were used for this contract review.

## Prioritized findings

### 1. P1 - Restoring an older database snapshot can resurrect a disconnected credential

Evidence: [connections.md](../specs/connections.md#L57) says an older database restore does not lower authority if current state and keys are checked, while [connections.md](../specs/connections.md#L81) makes revision monotonicity a property of the same restorable database.

Counterexample: a backup is taken while a delegated API key is `ready`, the user later disconnects it, and a restore returns the old `ready` row and ciphertext while the encryption key is available.

The restored row is now the result of the current-state check, and a provider without remote key revocation can still accept the old secret.

A database-local revision or current row read cannot reveal the post-backup disconnect.

Fix: define a restore protocol that quarantines restored connections until an authority epoch outside the restored snapshot is advanced, or fails closed by invalidating all restored grants and requiring fresh authorization.

Do not describe database restore alone as preserving revocation authority.

### 2. P1 - In-place delegated reauthorization can silently replace the external subject

Evidence: [connections.md](../specs/connections.md#L111) permits a replacement attempt on a ready connection and says a successful callback swaps credentials, but it does not require the external subject to match the prior grant.

Counterexample: binding X reconnects the same connection ID while the provider authorization page selects account B instead of the prior account A, after which later capability calls run as B without an explicit replacement decision.

The logical revision invalidates old results, but it does not prevent the new identity from silently taking over the existing user-selected connection.

Fix: require an in-place refresh or reauthorization to prove the same provider subject, and create a new connection ID for a different subject with an explicit selection or replacement step.

Keep the subject comparison server-side and expose only a safe display label where the client needs to confirm account selection.

### 3. P1 - Delegated authorization is not reachable through the specified HTTP and SDK surface

Evidence: [http-sdk-events.md](../specs/http-sdk-events.md#L61) lists no connection or authorization routes and says they are in `connections.md`, while [connections.md](../specs/connections.md#L269) defines only domain pseudotypes.

The SDK surface in [http-sdk-events.md](../specs/http-sdk-events.md#L201) has no begin, poll, cancel, connection-read, connection-list, or disconnect functions.

Counterexample: a Data App receives `CONNECTION_REQUIRED` and has no specified HTTP method to begin authorization, poll its attempt to obtain the resulting connection ID, or disconnect the grant.

This blocks the required delegated journey independently of the intentionally unresolved front-door choice.

Fix: define versioned browser routes and SDK methods for begin authorization, attempt status and cancellation, safe connection listing or reading, reconnect, and disconnect, plus a separately protected provider callback route.

The callback remains a protocol endpoint and must not accept browser-selected ownership or return credentials.

### 4. P1 - The one-effectful-dispatch invariant is not enforceable by the provider interface

Evidence: [core.md](../specs/core.md#L76) declares provider operations and their effects, but `CapabilityDefinition` has no operation allowlist and `AuthorizedProviderClient` has no declared method shape or dispatch budget.

The prose in [core.md](../specs/core.md#L89) limits one capability execution to one effectful dispatch, but a handler's access to a provider client is not scoped or counted in the types.

Counterexample: a buggy handler performs two individually allowlisted writes, the first succeeds, and the second fails, leaving a partial external effect behind a single `failed` or `outcome_unknown` result.

Fix: bind each capability to an explicit registered operation set and have the broker enforce a per-execution effectful-call budget of one.

A provider atomic batch may count as one operation only when its single-effect and failure semantics are documented and reviewed.

### 5. P1 - Event routing policy and provider event interfaces are required in prose but absent from shared types

Evidence: [http-sdk-events.md](../specs/http-sdk-events.md#L234) requires normalized event types and connection resolution, and [http-sdk-events.md](../specs/http-sdk-events.md#L252) requires explicit app event audiences.

The frozen `AppRegistration` in [contracts.md](../specs/contracts.md#L25) has no event subscription or audience declaration, and [core.md](../specs/core.md#L60) references an undefined `ProviderEventAdapter`.

Counterexample: an event verifier authenticates an event for an app credential, but the policy module has no shared typed rule that determines which bindings may receive the event or which fields are safe for their feed.

Fix: add a typed provider event adapter, normalized event envelope, app event subscription and audience rules, and a connection-generation binding to the shared contract, or explicitly defer client event delivery.

### 6. P1 - The provider credential and authorization interfaces cannot express the documented lifecycle

Evidence: [core.md](../specs/core.md#L69) defines `CredentialStrategy` as `oauth_code | api_key | static_secret | derived | none`, while [connections.md](../specs/connections.md#L137) supports refreshable OAuth and [connections.md](../specs/connections.md#L141) supports client-credentials grants.

`oauth_code` describes an authorization flow rather than a stored credential lifecycle, and the `AuthorizationAdapter` in [core.md](../specs/core.md#L71) only types `satisfies` while leaving begin, exchange, refresh, derive, and revoke as comments.

Counterexample: a provider declares client-credentials support, but the registry has no matching strategy value or typed acquire/refresh hook to validate against the app-owned grant lifecycle.

Fix: separate authorization flow from stored credential strategy and type the provider hooks with explicit supported or unsupported behavior for exchange, refresh, derivation, and revocation.

Preserve the explicit initial constraints that browser OAuth uses PKCE `S256` and API keys never appear in URLs, including query strings, and make transport registration reject violations.

### 7. P2 - Connection identity generation and credential revision are not named consistently across contracts

Evidence: R1 `SafeConnection` exposes one `revision` in [contracts.md](../specs/contracts.md#L38), [connections.md](../specs/connections.md#L81) defines that revision as logical authorization identity, and [http-sdk-events.md](../specs/http-sdk-events.md#L123) adds a separate logical connection generation.

The execution fingerprint in [execution.md](../specs/execution.md#L96) includes logical generation but excludes connection revision, even though the connection spec currently uses revision for that logical generation.

Counterexample: two modules use `revision` to mean the same logical grant generation while the HTTP contract checks `generation`, and a refresh implementation must guess which field changes on credential rotation.

Fix: use one shared logical grant or connection generation field consistently in `SafeConnection`, `ExecutionGrant`, executions, cursors, and result reads, with a separate internal credential version that may advance on refresh.

### 8. P2 - Authorization-attempt and refresh phase state models are not closed

Evidence: [connections.md](../specs/connections.md#L250) omits `created` from `AuthorizationAttemptState`, while [connections.md](../specs/connections.md#L123) specifies `created -> pending`.

The refresh lease record in [connections.md](../specs/connections.md#L53) has an untyped `refresh phase`, although recovery later depends on `prepared` and `dispatched` distinctions.

Counterexample: a persisted attempt or refresh row uses a state that its declared type cannot represent, so startup recovery cannot validate whether a late callback or refresh result is still admissible.

Fix: either make attempt creation atomic at `pending` and remove `created` from the transition text, or include `created` in the persisted state union.

Also define a closed refresh phase and terminal outcome set, with allowed transitions and stale-result behavior.

### 9. P2 - A delegated user cannot identify or choose among multiple provider connections safely

Evidence: [contracts.md](../specs/contracts.md#L38) intentionally omits external account IDs from `SafeConnection`, and [connections.md](../specs/connections.md#L169) says the authorization result page displays no account identifiers or labels.

No safe connection-list operation or client-facing account label is defined in [connections.md](../specs/connections.md#L269), even though reauthorization accepts a selected `connectionId`.

Counterexample: one binding has two grants for the same provider and the app must ask which one to use or replace, but the user sees only indistinguishable opaque IDs and cannot verify the external identity.

Fix: define an optional provider-mapped, minimal safe display label and an owner-scoped connection list, while prohibiting raw subject IDs, tokens, email addresses, or unreviewed provider claims.

## Shared-contract additions to resolve before convergence

The HTTP spec's top-level `page` field and the execution spec's cancellation metadata are not present in R1 `ExecutionRequest` or `ExecutionView`.

The connection identity generation and credential-version split must be promoted into the shared types before modules can independently implement refresh fencing and protected result reads.

Event subscription, audience, normalized event, feed cursor, and resync types need one owner and one shared definition before event routes are considered implementable.

Execution result, idempotency tombstone, event, and cursor retention choices remain open service policy and need concrete values before promising client retry behavior.

## Unresolved external choices, not contradictions

The trusted front-door transport, stable browser binding and trusted rebinding mechanism, and Tableau Cloud or Server compatibility are deliberately deferred by `GOALS.md`.

The first provider's refresh rotation, external subject, remote revocation, event identity, and idempotent write guarantees require provider-specific documentation and remain adapter choices.

The deployment's key service, backup restoration operations, and retention values require an operator decision before production use, although the restore rollback invariant must be specified now.
