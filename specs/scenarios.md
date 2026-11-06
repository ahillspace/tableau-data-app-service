# Cross-component scenario traces

Status: design checks for agent review, not executed integration tests.
Numbers correspond to [GOALS.md](../GOALS.md) acceptance scenarios.
All successful HTTP paths assume the deferred trusted adapter has supplied a valid app-scoped binding.
Where that assumption is absent, the safe result is UNAUTHENTICATED; no example grants authority from an app ID alone.

## 1. Discovery for a configured app

The adapter supplies app A and binding X; policy loads app A's current enabled registration and filters the static registry to its allowlist.
The response exposes versioned schemas, identity mode, effect and safe limits.
An unknown app, invalid proof or disabled app cannot discover protected configuration.
No provider request, credential refresh or personal authorization is needed for discovery.

## 2. No external credentials

App A invokes sample-beta.public-info@1 without a connection ID.
Policy verifies none identity and creates an execution grant without a connection.
The executor validates the input and uses the registered unauthenticated transport operation, validates its public output and records the result.
The viewer is not required to authorize an external personal account.
A supplied connection ID is rejected rather than used opportunistically.

## 3. Explicit app identity

App A invokes sample-beta.evaluate@1, whose app registration selects connection C owned by app A.
Policy confirms the capability's app identity, C's provider and granted authorization, then the broker resolves C's credential.
The handler cannot choose a different connection or obtain a raw credential.
Removing the configuration binding before dispatch prevents the operation; removing it after provider dispatch prevents further protected output delivery but cannot undo the provider request.

## 4. Delegated connection without local accounts

App A binding X invokes sample-alpha.lookup@1 without a connection and receives CONNECTION_REQUIRED.
Beginning authorization creates a short-lived attempt bound to A, X, provider and exact callback/return configuration.
The provider callback must validate the attempt, protocol response and binding continuity before an active delegated connection can be used.
Successful authorization records provider subject metadata only inside credential storage and safe ownership as A/X.
Retrying the invocation uses this connection and remains individual execution identity.
No user-profile record is introduced, and reconnecting from a different binding is forbidden until a trusted rebinding contract exists.

## 5. Stolen identifiers

App B binding Y supplies a connection ID owned by A/X.
Policy returns NOT_FOUND and creates no executable grant.
Binding Z within app A receives the same result for X's delegated connection.
An idempotency key, event cursor or execution ID copied from X likewise cannot bypass ownership checks.
A provider callback tied to X cannot itself establish Y as the connection owner.

## 6. Credential variety

The broker evaluates a credential's strategy, expiration and adapter-declared renewal support before dispatch.
A valid non-expiring key can be used without a refresh step; expiration is still possible by provider revocation and must surface safely.
An expiring credential with supported renewal is renewed under the shared lease/fencing rules.
An expired credential without renewal produces REAUTHORIZATION_REQUIRED or an explicit UNSUPPORTED strategy result, never a fabricated expiration extension.
A derived credential is scoped to its source connection generation, audience, authorization and bounded lifetime; changing the parent invalidates future derived use.
Provider-specific guarantees must be validated by its contract fixtures before a real adapter is considered supported.

## 7. Refresh, interruption and ambiguous writes

Two executions requesting the same refreshable credential share a single refresh claim; waiters observe the committed generation rather than independently refreshing.
If disconnect commits while refresh is in flight, the refresh result cannot reactivate the connection or overwrite its newer generation.
If a rotating refresh response is lost, the broker marks the connection as needing recovery/reauthorization according to the adapter guarantee, rather than repeatedly reuse an invalid token.
An authorization attempt closed by the browser expires and cannot be resumed merely by replaying callback parameters.
A provider write accepted before the service loses its response leaves outcome_unknown, preserving the execution ID for inspection and prohibiting automatic retry without an actual provider guarantee.

## 8. Pagination, write, limits and cancellation

A lookup accepts a bounded page size and returns Page<T> with an opaque cursor bound to caller, capability version, input/filter digest and connection generation.
Changing a filter or borrowing another binding's cursor fails before provider I/O.
Expiration requires restarting the read; clients must not assume a snapshot unless a provider explicitly offers one.
A write uses the same versioned invocation and result envelope while declaring stricter retry behavior.
Cancellation before dispatch yields cancelled; cancellation after a possibly effectful dispatch cannot assert rollback and may yield outcome_unknown.
Input size, output size, provider response size, timeout and per-app admission limits are enforced independently.

## 9. Incoming events and resync

The provider-specific verifier checks the raw event request before normalization and routing.
The event module atomically deduplicates the authenticated provider event ID and creates bounded delivery records for already-authorized bindings.
An event payload cannot nominate an app or binding to receive it.
Delivery/replay rechecks current registration and connection policy, and exposes only declared safe event data.
Duplicates do not produce duplicate logical events, but delivery can repeat and clients deduplicate by event ID.
A missing/expired replay range returns RESYNC_REQUIRED, and the client fetches the capability's supported current state instead of assuming gap-free history.
The event does not automatically trigger a write, workflow or unbounded background task.

## 10. Second provider extension

The implementer adds sample-beta's module, registered transport operations and capability definitions, with schema and lifecycle fixtures.
Static registry validation checks IDs, versions, schemas, effects, strategies and operation compatibility.
The operator enables the new capability versions for app A, explicitly configuring an app connection only where its identity mode requires one.
Existing sample-alpha handlers remain unchanged; both providers share connection storage, envelope handling and execution recovery.
An unsupported new credential behavior fails registration or returns UNSUPPORTED; it does not introduce an undocumented parallel credential store.

## Evidence limits

These traces establish intended observable outcomes and review obligations.
They are not automated tests, provider API experiments, a Tableau deployment check or proof of secure front-door transport.
Future implementation tests should exercise these same boundaries with real persistence concurrency and controlled provider failure injection.
