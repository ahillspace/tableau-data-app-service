# Access, connections and credentials

Status: proposed module contract.
The access owner controls app policy; the connections owner controls connection authority and authorization transactions; the credentials owner controls secret lifecycle.
Their shared types are defined in [contracts.md](contracts.md).

## Trusted request boundary

The selected front door must prove the configured app, binding lifetime and revocation, and an opaque holder whenever delegated connections are used.
It must prevent browser-supplied identity headers from bypassing verification and prevent a caller from choosing another holder key.
It must specify replay protection, audience restriction, transport confidentiality, and the difference between a renewed binding and a different holder.
Operator configuration maps that verified app to capabilities and service connections.
Origins support browser access controls and attribution checks; they confer no authority by themselves.
Trusted tests may construct access contexts directly, but production HTTP cannot enable that fixture adapter.

The core does not require a holder for no-credential or service capabilities.
A holder can be a private session binding with no human profile.
If the chosen boundary cannot prove continuity after a session ends, a new session cannot retrieve the old holder's delegated connections by email, external subject, app ID, or connection ID.
Durable recovery requires a later trusted continuity mechanism, not a heuristic account match.

The app registration contract is operator-only create/update/disable with expected revision.
Validation rejects duplicate capability versions, unknown providers, identity-incompatible service bindings, invalid origins and missing required limits.
The operator interface is a domain command, not a proposed self-service registration route.
Disabling an app prevents new connection flows, invocations, feed reads and result disclosure.

## Connection model and resolution

A connection records ID, provider registration, owner, state, authorization epoch, credential revision, permission evidence, and minimal safe status metadata.
It stores a provider subject only when needed to prove the execution account, prevent accidental account replacement, or route events.
That identity is private and provider-scoped; it is not a local login profile.
Names and emails are neither authority keys nor required fields.

| Capability identity | Connection resolution |
| --- | --- |
| `none` | Reject a supplied connection ID; execute without credentials. |
| `service` | Resolve only the connection selected by current app configuration; reject a different supplied ID. |
| `delegated` | Require a holder, then resolve a supplied visible ID or the sole eligible connection for that app, holder and provider registration. |

If several delegated connections are eligible and none is selected, return an explicit selection-required input error with only permitted safe connection references.
Resolution checks active app policy, enabled capability version, current connection state, owner, provider registration and required permission evidence.
For a service connection, the explicit current app binding provides use authority and does not grant connection-management authority to browser callers.
Service connection creation, replacement and disconnect are operator commands; browser disconnect applies only to an owned delegated connection.
Permission handling follows the capability's declared before-dispatch or provider-enforced contract.
A nonexistent connection and a connection owned by another holder return the same non-visible result.
The service never searches globally by external account identity to recover authority.

Connection states are `active`, `reauthorization-required`, `renewal-uncertain`, and `disconnected`.
Credential expiry is data, not a separate connection ownership state.
Temporary provider unavailability does not disconnect or reassign the connection.
`disconnected` is terminal for that connection ID; reconnecting after disconnect creates a new connection.
Reauthorization of a still-owned connection preserves its ID and increments its authorization epoch on successful replacement.

## Authorization transaction

```ts
type AuthorizationRequest = {
  capability: { id: string; version: number };
  connectionId?: string;
  returnTarget: string;
};

type AuthorizationView = {
  id: string;
  state: "awaiting-provider" | "verifying" | "complete" |
         "denied" | "failed" | "expired";
  expiresAt: string;
  authorizationUrl?: string;
  connectionId?: string;
};

type DisconnectResult = {
  localState: "disconnected";
  providerRevocation: "confirmed" | "not-supported" | "unconfirmed";
};
```

`begin` derives the provider registration, requested permission set, owner, and replacement epoch from the permitted capability and verified access.
The browser does not supply arbitrary scopes, client credentials, token endpoints, owner keys or callback URLs.
`returnTarget` selects an exact configured return target rather than an arbitrary redirect URL.
Service credential creation uses the operator path, never a browser-declared service identity.

The transaction persists a random state digest, provider/issuer binding, exact callback and return targets, initiating access association, expiry, encrypted protocol verifier, and any expected old connection epoch.
An authorization landing page binds the transaction to an initiating browser correlation secret before redirecting to the provider.
The recommendation is a short-lived Secure HttpOnly first-party correlation cookie scoped to this flow, independently of any general login session.
Its actual popup and browser behavior must be verified in the target environment.
The callback must validate that browser correlation, one-time state, configured issuer/callback binding and protocol response before exchanging a code.
Absent browser correlation fails closed and permits a new explicit attempt; it does not silently drop the check.

OAuth code flows use a maintained library, PKCE where supported, and server-side token exchange.
Provider exceptions to the preferred secure protocol profile require a documented adapter review, not a global disable switch.
OIDC subject evidence requires library validation of the issuer, client audience, signature policy, expiry and transaction nonce.
An arbitrary decoded access token is not identity evidence.
Other protocols supply an explicit provider-validated identity signal or declare the requested identity behavior unsupported.

Claim `awaiting-provider -> verifying` atomically before code exchange.
Duplicate callbacks cannot exchange the same code concurrently.
Successful validation commits the credential, connection association and completed authorization status atomically, conditioned on current app policy, unexpired initiating authority, holder association and expected replacement epoch.
If the initiating authority has expired, the attempt fails and a fresh authorized flow is required.
Replacement must prove the same external subject when the old connection has a verified subject; account switching creates a new connection instead.
If the provider cannot prove account continuity, same-ID reauthorization is unsupported and a new connection is required.

Provider denial terminates the transaction without modifying an existing connection.
Timeout or process interruption after code exchange may have consumed the code; do not automatically replay it.
Mark the attempt failed, discard uncommitted credentials, and require a new explicit authorization flow.
Any remote grant that could not be stored is an operational cleanup concern, not a usable local connection.
Callbacks and popup messages expose only a safe completion signal.
The initiating client reads the transaction through its verified access before using the resulting connection.
Raw codes, tokens, subjects and protocol errors are never placed in the app return URL or popup payload.

## Credential lifecycle

The provider declares credential production separately from execution identity.
A connection's secret record is encrypted and authenticated with context binding to its connection ID, provider registration and credential revision.
Encryption key identifiers allow rotation; key material remains outside the database.

| Credential property | Required behavior |
| --- | --- |
| Known expiry | Renew before the request safety margin or return reauthorization-required if renewal is unavailable. |
| Explicitly non-expiring | Use until provider rejection, replacement or disconnect; do not invent refresh calls. |
| Unknown expiry | Adapter declares validation-on-use or another evidence-backed validity strategy; missing strategy is unsupported. |
| Renewable token | Adapter declares renewal inputs, replacement rules, token-rotation behavior and ambiguity recovery. |
| API key or static secret | Validate configured shape and optional provider probe; operator replaces it, with no assumed OAuth lifecycle. |
| Derived short-lived credential | Adapter declares one base secret, audience and permission bounds, expiry, and regeneration safety. |
| Unimplemented protocol | Registration fails or the operation returns unsupported before any remote effect. |

Derived credentials remain attached to the same connection and authorization epoch.
They are invalidated when that epoch or their base-secret revision changes, and never imply a different execution identity.
The initial design does not need a general credential dependency graph.
Provider hooks validate the complete replacement credential before persistence and distinguish an omitted replacement refresh token from explicit removal according to documented protocol semantics.

## Renewal and disconnect races

Acquire a durable per-connection renewal claim in a short transaction, recording the starting authorization epoch and credential revision.
Another requester rereads the latest credential or waits within its own deadline; it does not independently refresh the same revision.
Record a dispatch marker before the renewal request can leave the process.
The response is committed only if claim ownership, epoch, revision and non-disconnected state still match.
An in-process promise may reduce duplicate waiting, but database state provides correctness across restarts.

If a claim ends before its dispatch marker, renewal can be attempted again.
If a dispatched renewal loses its response or owner, rotating or otherwise replay-unsafe credentials enter `renewal-uncertain`.
A lease timeout never by itself permits replay of that renewal.
Reauthorization restores the connection through a new epoch.
Only an adapter with documented safe regeneration or a definitive provider reconciliation result can recover without reauthorization.
Definite transient failures use bounded backoff; definite invalid-grant or revoked credentials require reauthorization.
Expiry alone does not justify marking a non-refreshable connection permanently broken before its last usable credential expires.

Disconnect first commits `disconnected`, increments the authorization epoch, cancels unfinished authorization replacements and blocks further dispatch admission.
The credentials owner removes active secret material and makes any in-memory authorization handles unusable.
If remote revocation is supported, it may use a short-lived in-memory cleanup copy after the local commit.
Failure or process interruption during that best-effort revocation returns or records `unconfirmed`; local disconnect remains effective.
This baseline does not promise a durable remote-revocation retry queue.
An old refresh response cannot revive the connection, even when provider revocation was unavailable or failed.

The outbound boundary rechecks current authority and connection epoch immediately before each dispatch.
A request admitted before disconnect may still reach the provider or complete afterwards.
The service does not claim it can undo that effect, and it rechecks disclosure authority before returning any result.
