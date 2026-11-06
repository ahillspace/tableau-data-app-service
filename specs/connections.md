# Connections and credentials

Status: proposed component specification for architecture review.

This component owns connection authorization attempts, connection lifecycle, encrypted credential storage, credential refresh and derivation, and disconnect fencing for one shared internal solutions engineering service.

It does not add customer tenants, local human accounts, a self-service onboarding portal, a new front-door platform, or a provider-specific capability.

The shared contracts in `specs/contracts.md` are frozen at R1 for this drafting round, so this document records required contract additions without changing that file.

## Requirements and recommendations

The user-stated operating requirements are one team-managed service, app-level attribution, delegated individual authorization when the capability requires it and the provider supports it, no silent identity fallback, server-side secrets, and no authority from a connection ID alone.

The architecture recommendations below make authorization attempts and credential versions independently fenced, keep operator provider-client secrets separate from connection credentials, and make ambiguous external writes visible as requiring reauthorization or operator action.

The design assumes the future front door can provide the stable, server-verified `TrustedContext` in R1 and can route a configured provider callback to this service over TLS.

The front-door transport, browser binding, callback host, callback routing configuration, and Tableau deployment compatibility remain unresolved and are not specified here.

## Ownership and trust boundary

The connection service owns connection records, encrypted credentials, authorization-attempt records, refresh leases, refresh fencing, revocation cleanup state, and the safe connection views returned to callers.

The app-registration owner selects app connections through current `AppRegistration` policy and owns the app revision checked by execution admission and dispatch.

The execution service owns execution grants, capability identity selection, retry decisions, execution cancellation, and write-outcome uncertainty.

Provider modules own provider-specific authorization URLs, token exchange, refresh, derivation, revocation, external subject parsing, and allowlisted error mapping.

Only a trusted adapter constructs `TrustedContext`; connection methods derive delegated ownership from its `appId` and `bindingId` and never accept an owner supplied in request data.

An app ID, origin, callback state value, attempt ID, connection ID, authorization URL, external subject, and provider token do not independently prove caller authority.

An app connection belongs to exactly one configured `appId`, while a delegated connection belongs to exactly one pair of `appId` and stable `bindingId`.

Provider authorization may identify an external subject, but the service stores only metadata required to distinguish or operate the grant and never creates a local person or developer account from it.

The R1 `bindingId` is a server-verified principal, not a Tableau viewer name or Tableau session, and stable identity or trusted rebinding remains a front-door contract requirement.

## Internal records and storage ownership

Postgres is the system of record for connection state, revisions, authorization attempts, refresh leases, and encrypted credential envelopes.

The connection module owns its tables and migrations within the shared database and exposes domain methods rather than storage queries to other modules.

The connection row contains an opaque ID, provider ID, owner kind and owner IDs, lifecycle state, logical connection revision, credential version, active authorization-attempt ID when applicable, and timestamps.

The credential envelope contains the credential strategy, encrypted secret payload, encryption key version, provider authorization metadata, optional external expiry, and optional parent connection and parent credential version for derived credentials.

The authorization-attempt row contains the attempt ID, provider ID, owner, optional target connection ID, expected connection revision, state, expiry, callback correlation hash, encrypted PKCE verifier where applicable, provider client-configuration revision, and safe timestamps.

The refresh lease row contains the connection ID, expected credential version, monotonically increasing fencing number, lease expiry, refresh phase, and recovery classification supplied by the provider module.

The database stores no plaintext provider token, refresh token, API key, OAuth client secret, authorization code, PKCE verifier, or derived secret.

Credential ciphertext uses envelope encryption through a managed key service or an equivalent separately protected key-encryption key, with authenticated encryption and associated data binding ciphertext to provider, connection, owner, and credential version.

Database backups, snapshots, exports, and replicas contain ciphertext only, and restoring an older database snapshot does not restore or lower external authorization authority without a current connection-state check and key availability.

Secret decryption is limited to the connection service and the provider transport that must attach a credential to an outbound request.

Capability implementations receive an opaque `AuthorizedProviderClient` for one execution and never receive a raw token, refresh token, API key, client secret, or decryption key.

Provider endpoints, OAuth redirect URIs, callback routes, issuer identity, client authentication mode, and provider client registrations come from operator-reviewed configuration and cannot be selected by caller input.

Operator provisioning is a separate trusted control-plane operation and is not available through Data App calls or capability execution.

Operator provider-client secrets such as OAuth client secrets are stored separately from app or delegated connection credentials, have their own revision and rotation lifecycle, and cannot be used as proof of an external user's identity.

An app identity connection is an explicitly configured service credential for an app, such as an operator-provisioned API key or client-credentials grant, and its ID must match the app registration's selected connection.

A delegated connection stores an individual's provider grant for one app and binding pair, even when the service uses a shared operator-registered OAuth client to obtain that grant.

Secret input and provider responses are redacted before logging, metrics, tracing, error reporting, and audit serialization.

Audit records may include app ID, binding ID, provider ID, opaque connection or attempt ID, state transition, revision, request ID, actor class, outcome class, and timestamps, but not external subject identifiers or secret material.

## Revisions, ownership, and dispatch fencing

The public `SafeConnection.revision` is a logical authorization revision that increases when owner, provider grant, enabled state, or usable credential set changes and never decreases.

Refresh-token rotation that continues the same provider grant increases the internal `credentialVersion` but does not by itself change the logical connection revision.

Replacing a grant, changing its owner or provider, disabling it, or disconnecting it changes the logical revision and fences existing execution grants.

Each execution grant captures app revision, connection ID, logical connection revision, identity mode, binding owner when delegated, capability version, and provider authorization requirement.

Before outbound dispatch, the provider transport rechecks current app policy, connection state, owner equality, logical connection revision, execution cancellation, and deadline.

An accepted external request may not be recalled by a later disconnect, so a disconnect prevents future dispatch and refresh but cannot promise cancellation of a request already accepted externally.

Refresh commits use compare-and-swap against the expected credential version and a monotonically increasing fencing number so a late refresh response cannot overwrite a newer credential or revive a disconnected connection.

## Connection and authorization-attempt state machines

The shared `ConnectionState` values in R1 remain the only externally visible connection states.

An initial authorization creates a provisional connection in `authorizing` and an authorization attempt in `pending`.

Successful callback validation and token exchange atomically install the credential envelope, increment the logical revision and credential version, and transition the connection to `ready` and attempt to `succeeded`.

A valid, state-matched provider denial transitions the attempt to `failed`; an initial provisional connection becomes `reauthorization_required` and exposes no credential.

Malformed, unverifiable, expired, or provider-mismatched callbacks are rejected without changing an attempt or connection, while a valid correlated OAuth error response records a safe failure outcome.

An expired pending attempt becomes `expired`; an initial provisional connection becomes `reauthorization_required` and can be replaced by a fresh attempt.

An attempt may be cancelled before exchange, after which a callback for that attempt cannot install a credential.

A ready connection may have a replacement authorization attempt in progress while the currently valid grant remains usable; a successful replacement swaps credentials under revision compare-and-swap.

A terminal provider response such as revoked or invalid refresh authorization transitions a ready connection to `reauthorization_required` and blocks use of the invalid grant.

Operator policy can transition a connection to `disabled`, which blocks authorization and execution without deleting its credential.

Only an explicit operator enable action may restore a disabled connection, and it restores `ready` only after current policy and credential validity are checked, otherwise it restores `reauthorization_required`.

Disconnect immediately fences the logical revision, changes state to `disconnected`, invalidates pending authorization and refresh attempts, and prevents credential use.

`disconnected` is terminal for that connection ID; a later connect creates a new connection ID so stale callbacks and grants cannot resurrect it.

An authorization attempt follows `created -> pending -> callback_received -> exchanging -> succeeded` for the successful path.

Other terminal attempt states are `failed`, `cancelled`, `expired`, and `outcome_unknown`, and no terminal attempt can become pending or succeed later.

Duplicate callbacks for a terminal successful attempt return the stored safe completion result without exchanging the code again, while duplicate or late callbacks for any other terminal attempt do not mutate connection state.

When the callback code may have been redeemed but the token response or commit is ambiguous, the attempt becomes `outcome_unknown` and the affected connection requires fresh authorization rather than assuming that retrying the code is safe.

## Supported credential strategies

Every provider module declares each supported strategy and its lifecycle properties before registry construction, and registration fails if a capability requires an undeclared or unsupported strategy.

| Strategy | Storage and use | Expiry and recovery |
| --- | --- | --- |
| Expiring OAuth access credential without refresh token | Store encrypted access credential and grant metadata. | Calculate expiry from provider response and local receipt time, apply a provider-specific safety margin, and require fresh authorization after expiry. |
| Refreshable OAuth grant | Store access and refresh credentials as one encrypted version and refresh only through a fenced lease. | Apply returned token rotation atomically and require fresh authorization when refresh is terminally rejected or its result is ambiguous and unsafe to repeat. |
| Non-expiring bearer credential | Store encrypted credential only when the provider explicitly documents no expiry. | Do not infer indefinite validity from a missing expiry field; support operator or owner replacement and provider-side revocation. |
| API key | Store encrypted key, provider-defined placement metadata, and optional operator expiry or rotation metadata. | Never send in a URL; rotate or revoke through the documented provider path, and require operator action when the provider has no revocation operation. |
| Client-credentials or other app/service grant | Store the resulting app-owned credential separately from the operator OAuth client secret used to obtain it. | Refresh under the app connection owner and never expose or use it for delegated identity. |
| Derived or exchanged credential | Derive from an already authorized parent credential when the provider supports a narrower or shorter-lived downstream credential. | Bind it to parent connection ID and credential version, cache only until provider expiry, and invalidate on parent replacement, disconnect, or insufficient lifetime. |
| Unsupported or unclassifiable credential | Do not store or use it. | Return `UNSUPPORTED` with a safe explanation until the provider module documents lifecycle, storage, refresh, and revocation semantics. |

An access token with a missing or malformed `expires_in` is treated according to provider-specific documented behavior and never silently reclassified as non-expiring.

An API key or non-expiring token may be usable without refresh, but its external validity is not guaranteed by the local `ready` state.

Derived credentials are not a way to elevate privilege or switch identity, and the provider module must prove that their scope and subject are no broader than the parent authorization.

The core does not accept resource-owner passwords or OAuth's resource-owner password credentials grant.

An interactive provider flow that cannot be safely bound to an authorization attempt and a delegated owner is unsupported until a provider module documents and reviews its complete lifecycle.

## OAuth authorization and safe callback experience

For supported browser authorization, the provider module uses the Authorization Code flow with PKCE `S256`, exact registered redirect URIs, a short-lived one-time state correlation value, and server-side callback handling.

The service stores only a hash of the random state value and binds it to one pending attempt, provider, owner, redirect URI, and expiry.

The PKCE verifier is encrypted while pending, used only for the token exchange, and erased when the attempt becomes terminal.

The callback handler validates the provider-specific issuer or fixed endpoint context, state, expiry, redirect URI, expected attempt state, and any required OpenID Connect nonce before exchanging a code.

The callback route accepts only the provider parameters required by its registered protocol adapter and rejects duplicate, oversized, malformed, or unexpected parameters.

The callback query string, authorization code, state value, provider error description, and token endpoint response are not written to access logs, analytics, browser storage, or referrer-bearing pages.

The authorization response page says only that authorization completed, was denied, expired, or could not be confirmed, and directs the user back to the configured app without displaying account identifiers or provider payloads.

The initiating app polls a protected authorization-attempt read method under the original trusted app and binding context to learn the safe outcome and connection readiness.

The callback state is correlation and CSRF protection only; it cannot read a connection, select a capability, create a local identity, or authorize an execution.

If the browser is closed, provider interaction is abandoned, or callback delivery is lost, the attempt remains pending until cancellation or its short server-side TTL expires, after which the app can start a new attempt.

If the service exchanged a callback code but crashed before durably committing returned credentials, recovery uses the provider's documented code and token semantics; when the exchange may have succeeded and cannot be safely replayed, the attempt is `outcome_unknown` and a fresh authorization is required.

The OAuth implementation follows the current IETF OAuth security best current practice and uses an established protocol library for parsing, validation, and token exchange instead of hand-written protocol handling.

The initial OAuth support excludes implicit flow and resource-owner password flow, and it does not claim support for provider-specific extensions without a provider module review.

## Refresh coordination, rotation, and crash recovery

The service never holds a database transaction open across a token endpoint request.

A refresh worker atomically claims a lease for the expected connection ID, logical revision, credential version, and next fencing number, then marks the request phase as `prepared` before making any provider call.

Immediately before sending a refresh request, it records phase `dispatched` under the same fencing number and verifies that the connection remains ready and unchanged.

On successful response, the worker encrypts all returned credentials and atomically commits them only if the connection is still ready, the logical revision and expected credential version still match, and the fencing number is current.

If a response omits a replacement refresh token, the provider declaration determines whether the previous token remains valid; the core never assumes this behavior across providers.

If a provider rotates refresh tokens, the new access token and replacement refresh token are committed together as one credential version so the database cannot retain only half of the rotation.

If a worker crashes before phase `dispatched`, another worker may reclaim the lease after expiry and start the refresh.

If a worker crashes after phase `dispatched`, the result may be ambiguous; another worker may retry only when the provider explicitly declares refresh replay safe, a grace window, or equivalent recovery semantics.

When refresh replay is not declared safe, an expired dispatched lease transitions the connection to `reauthorization_required`, fences the old credential version, and avoids reuse of a possibly rotated refresh token.

Other workers wait for the current lease or receive a retryable provider-busy result and never independently send the same refresh token while a valid lease exists.

Late responses from stale workers are discarded and cannot restore a disconnected, disabled, replaced, or newer connection.

Providers that use sender-constrained refresh credentials, replay detection, rotation, or a documented grace period declare those behaviors and recovery rules explicitly.

## Disconnect, revocation, and races

Disconnect first commits the local disconnected state and new logical revision in a short transaction, then attempts remote revocation using a restricted cleanup record if the provider supports revocation.

This ordering makes local authorization denial immediate even if the provider is unavailable.

Remote revocation success is reported only after the provider confirms the documented revocation outcome, and a timeout or failure is recorded as remote revocation unconfirmed.

If revocation requires a secret, the service may retain its encrypted cleanup copy only in a restricted, time-bounded revocation queue that cannot be used to execute capabilities or refresh credentials.

The cleanup copy is erased after confirmed revocation or the configured retention deadline, and the user-facing safe result never implies that remote revocation succeeded when it did not.

When a provider offers no revocation endpoint, the service deletes its local credential material and tells the operator or delegated user that provider-side revocation may require a separate provider action.

An authorization callback racing with disconnect cannot commit because its expected logical revision or active attempt no longer matches, and any newly received token is securely discarded or best-effort revoked.

A refresh racing with disconnect cannot commit because its logical revision, state, or fencing number is stale, and it cannot move a connection out of `disconnected`.

A request already dispatched before disconnect may still complete externally; the execution service reports the result or `outcome_unknown` according to its effect semantics.

## Provider extension requirements

Each provider module declares its stable provider ID, fixed authorization and token endpoints, redirect URI policy, operator client configuration schema, supported identity modes, credential strategies, expiry rules, refresh replay and rotation semantics, derivation semantics, revocation semantics, and external subject handling.

Each authorization-capable provider implements begin, callback validation, code exchange, required issuer or audience checks, safe failure mapping, and optional grant revocation through established protocol libraries.

Each refresh-capable provider declares whether refresh credentials rotate, whether the previous token remains valid when no replacement is returned, whether duplicate requests are safe, and how the module classifies ambiguous outcomes.

Each derived-credential provider declares scope attenuation, parent-binding requirements, maximum lifetime, cache key, refresh behavior, and invalidation behavior.

Every provider module validates token endpoint response shape and provider-specific identity claims before storing a credential, and rejects unknown or invalid response fields where they affect security decisions.

Provider implementations cannot choose network destinations from callback data, capability input, or external account metadata, and outbound HTTP uses the project's established TLS-capable HTTP client with bounded timeouts and response sizes.

Provider responses and errors are mapped to the shared allowlisted `Problem` contract without raw bodies, secret values, stack traces, URLs, or external subject identifiers.

## Narrow pseudotype entrypoints

The connection component should expose framework-independent operations equivalent to the following pseudotypes, with the final signatures owned by the architecture orchestrator.

```ts
type AuthorizationAttemptState =
  | 'pending' | 'callback_received' | 'exchanging' | 'succeeded'
  | 'failed' | 'cancelled' | 'expired' | 'outcome_unknown';

type AuthorizationStart = {
  attemptId: Id;
  authorizationUrl: string;
  expiresAt: string;
};

type AuthorizationAttemptView = {
  id: Id;
  providerId: string;
  state: AuthorizationAttemptState;
  connection?: SafeConnection;
  expiresAt: string;
  updatedAt: string;
};

beginAuthorization(
  ctx: TrustedContext,
  request: { providerId: string; connectionId?: Id }
): Promise<Result<AuthorizationStart>>;

readAuthorizationAttempt(
  ctx: TrustedContext,
  attemptId: Id
): Promise<Result<AuthorizationAttemptView>>;

cancelAuthorization(
  ctx: TrustedContext,
  attemptId: Id
): Promise<Result<AuthorizationAttemptView>>;

disconnect(
  ctx: TrustedContext,
  connectionId: Id
): Promise<Result<SafeConnection>>;

handleProviderCallback(
  providerId: string,
  protocolResponse: unknown
): Promise<SafeCallbackResult>;
```

`beginAuthorization` always creates or reauthorizes a delegated connection owned by the context's app and binding, and the optional connection ID is valid only for a connection already owned by that exact pair.

App/service credentials are provisioned through a separate operator-only control path and never through `beginAuthorization` on the browser-facing contract.

`handleProviderCallback` is a server adapter entrypoint without `TrustedContext`; it consumes only a pending one-time state record and returns a generic callback page result without returning a connection or credential to the browser.

The final shared contract must define `AuthorizationStart`, safe attempt reads, callback admission, idempotent cancellation, owner-scoped reconnect selection, callback result behavior, and whether callback protocol parsing belongs to the connection provider module or a transport adapter.

## Failure and recovery scenarios

| Scenario | Required result and recovery |
| --- | --- |
| A delegated binding is missing or no longer current. | Reject with `UNAUTHENTICATED` or `FORBIDDEN` according to the trust adapter and do not create an attempt. |
| A caller submits another binding's connection ID. | Return `NOT_FOUND` without revealing connection existence. |
| The connection strategy is not implemented or its lifecycle is undocumented. | Return `UNSUPPORTED` and do not persist a secret. |
| Provider authorization is denied. | Mark the attempt `failed`, expose a safe denial state, and allow a fresh attempt. |
| Callback state is invalid, expired, reused, or for another provider. | Reject without token exchange and without changing another attempt or connection. |
| Token exchange returns an invalid response. | Do not persist returned fields, fail the attempt, redact the provider response, and require fresh authorization if token creation may have occurred. |
| Token exchange may have succeeded but the response or database commit was lost. | Mark `outcome_unknown` when recoverable evidence permits, fence the candidate grant, and require fresh authorization rather than replaying an authorization code. |
| Refresh returns invalid-grant or revoked authorization. | Move to `reauthorization_required`, block dispatch, and prompt a new delegated attempt. |
| Refresh times out with a rotated-token provider. | Use provider-declared replay recovery only; otherwise require reauthorization and never blindly replay the old refresh token. |
| Two refresh workers race. | Commit at most one current credential version through lease and fencing checks; discard the stale worker response. |
| Disconnect races with refresh or callback. | Commit disconnected revision first, reject stale commits, discard or best-effort revoke newly issued credentials, and keep the connection disconnected. |
| Provider revocation times out after local disconnect. | Keep local use disabled, label remote revocation unconfirmed, and retry cleanup only through a restricted bounded mechanism. |
| Decryption key service is unavailable. | Fail closed with a safe internal/provider-unavailable problem, do not send an unauthenticated request, and retain ciphertext for later recovery. |
| Encryption key version is missing or invalid after restore. | Fail closed, alert operators without secret contents, and recover only through documented key restoration or fresh authorization. |
| Provider endpoint is slow or returns an oversized response. | Enforce bounded timeout and response size, redact the body, preserve state according to request ambiguity, and return a safe retry classification. |
| Provider returns a non-expiring token with no documented validity semantics. | Reject the strategy as unsupported rather than infer non-expiring behavior. |
| A request was dispatched immediately before disconnect. | Preserve the execution result or report `outcome_unknown`; never claim disconnect recalled the external operation. |

## Protocol references and review assumptions

OAuth authorization-code and client-credentials behavior is based on [RFC 6749](https://www.rfc-editor.org/rfc/rfc6749), as updated by current security guidance.

OAuth browser authorization uses [PKCE from RFC 7636](https://www.rfc-editor.org/rfc/rfc7636) with the `S256` challenge method.

OAuth security requirements follow [RFC 9700, Best Current Practice for OAuth 2.0 Security](https://www.rfc-editor.org/rfc/rfc9700), including PKCE and rejection of the resource-owner password credentials grant.

Provider revocation uses [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009) where supported, while provider-specific behavior remains explicitly declared.

This draft assumes no named provider is selected, so exact OAuth metadata discovery, response validation, token lifetime, revocation, refresh rotation, and derived-credential semantics remain provider-module decisions.

This draft assumes an internal operator can provision and rotate provider client secrets through a trusted mechanism, but the exact operator interface and key service are unresolved.

This draft assumes the front door can preserve or re-establish a stable binding for delegated connection ownership, but it does not decide how a Data App browser obtains or proves that binding.

This draft assumes a configured callback can reach the service without making callback state an execution credential, but callback hosting and browser return navigation remain unresolved.
