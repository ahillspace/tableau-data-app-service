# Connections and credentials

Status: proposed component specification for architecture review.

This component owns connection authorization attempts, connection lifecycle, encrypted credential storage, credential refresh and derivation, and disconnect fencing for one shared internal solutions engineering service.

It does not add customer tenants, local human accounts, a self-service onboarding portal, a new front-door platform, or a provider-specific capability.

The shared contracts in [contracts.md](contracts.md) are the integrated R3 source of interface names and state unions.

## Requirements and recommendations

The user-stated operating requirements are one team-managed service, app-level attribution, delegated individual authorization when the capability requires it and the provider supports it, no silent identity fallback, server-side secrets, and no authority from a connection ID alone.

The architecture recommendations below make authorization attempts and credential versions independently fenced, keep operator provider-client secrets separate from connection credentials, and make ambiguous external writes visible as requiring reauthorization or operator action.

The design assumes the future front door can provide the stable, server-verified `TrustedContext` in the shared contract and can route a configured provider callback to this service over TLS.

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

The shared `bindingId` is a server-verified principal, not a Tableau viewer name or Tableau session, and stable identity or trusted rebinding remains a front-door contract requirement.

## Internal records and storage ownership

Postgres is the system of record for connection state, revisions, authorization attempts, refresh leases, and encrypted credential envelopes.

The connection module owns its tables and migrations within the shared database and exposes domain methods rather than storage queries to other modules.

The connection row contains an opaque ID, provider ID, owner kind and owner IDs, lifecycle state, logical connection revision, credential version, active authorization-attempt ID when applicable, and timestamps.
Connections, credentials, attempts and refresh claims also retain the authority epoch under which they were created; an older epoch is never usable after recovery.

The credential envelope contains the credential strategy, encrypted secret payload, encryption key version, provider authorization metadata, optional external expiry, and optional parent connection and parent credential version for derived credentials.

The authorization-attempt row contains attempt ID, provider ID, owner, optional target connection ID, expected logical revision, app revision, authority epoch/expiry, state, expiry, exchange claim fence, callback correlation hash, encrypted PKCE verifier, provider configuration revision and safe timestamps.

Callback exchange is claimed atomically once; duplicate callbacks while exchanging return generic unconfirmed status and never exchange the code twice.

Before installing a candidate, check current app policy/revision, stored binding validity, callback continuity, authority epoch, attempt expiry and fence, and target connection revision.

A disabled app or revoked/expired binding prevents installation even if provider authorization succeeded, and candidate secrets are discarded or sent to restricted revocation cleanup.

The trusted adapter must supply current binding checks and callback continuity proof; state correlation alone is insufficient, and no activation is supported before that deferred adapter exists.

The refresh lease row contains the connection ID, expected credential version, monotonically increasing fencing number, lease expiry, refresh phase, and recovery classification supplied by the provider module.

The database stores no plaintext provider token, refresh token, API key, OAuth client secret, authorization code, PKCE verifier, or derived secret.

Credential ciphertext uses envelope encryption through a managed key service or an equivalent separately protected key-encryption key, with authenticated encryption and associated data binding ciphertext to provider, connection, owner, and credential version.

Database backups, snapshots, exports, and replicas contain encrypted credential material, but a restored snapshot can contain stale authority and cannot prove that later disconnects or token rotations did not occur.

Restore is an offline recovery operation: disable ingress and workers, advance an authority epoch stored outside the database restore boundary, invalidate existing bindings/attempts/cursors and execution grants, quarantine restored credentials, and require fresh delegated authorization or explicit operator re-provisioning of app credentials.

Resume only after every module checks the new epoch; restored writes with dispatch intent are outcome_unknown until reviewed and must never be automatically replayed.

The operator must reconcile the backup gap for writes absent from the restored database, because no restored idempotency table can prove that those writes did not occur.

Write admission remains disabled until the operator records a disposition for that backup gap; a new epoch alone does not authorize replay or restore idempotency protection for missing rows.

The exact epoch store and recovery runbook are deferred operational choices; safe automatic database restore is not claimed.

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

The public `SafeConnection.revision` is the logical authorization revision that increases on grant replacement, permission change, enable/disable, disconnect and recovery invalidation within an authority epoch.

Owner and provider are immutable for a connection ID; a different owner, provider or external subject requires a new connection.

Routine secret rotation preserving the same grant changes only internal credentialVersion.

Refresh-token rotation that continues the same provider grant increases the internal `credentialVersion` but does not by itself change the logical connection revision.

Replacing the same-subject grant, disabling it, or disconnecting it changes the logical revision and fences existing execution grants.

A refresh that changes granted permissions also changes the logical revision and requires new policy evaluation.

Each execution grant captures app revision, connection ID, logical connection revision, identity mode, binding owner when delegated, capability version, and provider authorization requirement.

Before outbound dispatch, the provider transport rechecks current app policy, connection state, owner equality, logical connection revision, execution cancellation, and deadline.

Disconnect prevents new dispatch intent or refresh claims after its local commit.

Already-committed dispatch/refresh intent is in flight even if the network send occurs later, because a database check and provider send cannot be atomic.

The transport rechecks before send, but neither that check nor lease fencing promises recall or absence of later wire traffic.

Refresh commits use compare-and-swap against the expected credential version and a monotonically increasing fencing number so a late refresh response cannot overwrite a newer credential or revive a disconnected connection.

## Connection and authorization-attempt state machines

The shared `ConnectionState` values in the shared contract remain the only externally visible connection states.

An initial authorization creates a provisional connection in `authorizing` and an authorization attempt in `pending`.

The proposed attempt TTL is ten minutes or the trusted authority expiry, whichever comes first; only one nonterminal attempt per owner/provider/reconnect target is active, and a new begin atomically fences the old attempt.

Beginning authorization requires at least one currently enabled delegated capability for that provider; the provider-requested authorization is the reviewed union of those requirements, never a browser-supplied permission set.
The provider adapter combines that requirement set under the operator-configured authorization ceiling and rejects unsupported combinations instead of guessing scopes.
Newly enabled permissions require a new explicit authorization attempt; background refresh must not expand the grant.

Successful callback validation and token exchange atomically install the credential envelope, increment the logical revision and credential version, and transition the connection to `ready` and attempt to `succeeded`.

A valid, state-matched provider denial transitions the attempt to `failed`; an initial provisional connection becomes `reauthorization_required` and exposes no credential.

Malformed, unverifiable, expired, or provider-mismatched callbacks are rejected without changing an attempt or connection, while a valid correlated OAuth error response records a safe failure outcome.

An expired pending attempt becomes `expired`; an initial provisional connection becomes `reauthorization_required` and can be replaced by a fresh attempt.

An attempt may be cancelled while nonterminal, including during exchange; cancellation advances its fence so any later token response cannot install a credential.

A token already issued after cancellation may need restricted cleanup; cancellation does not promise external revocation.

A ready connection may have a replacement authorization attempt while the current grant remains usable.

In-place reauthorization must verify the same provider subject through provider-validated metadata, then swap credentials under revision compare-and-swap and increment the logical revision.

A different or unverifiable subject fails in-place replacement; the caller must intentionally create and select a new connection ID.

The old ready grant remains unchanged on a failed replacement unless the provider reports that it has independently become invalid.

A terminal provider response such as revoked or invalid refresh authorization transitions a ready connection to `reauthorization_required` and blocks use of the invalid grant.

Operator policy can transition a connection to `disabled`, which blocks authorization and execution without deleting its credential.

Only an explicit operator enable action may restore a disabled connection, and it restores `ready` only after current policy and credential validity are checked, otherwise it restores `reauthorization_required`.

Disconnect immediately fences the logical revision, changes state to `disconnected`, invalidates pending authorization and refresh attempts, and prevents credential use.

`disconnected` is terminal for that connection ID; a later connect creates a new connection ID so stale callbacks and grants cannot resurrect it.

Attempt creation atomically inserts `pending`; the successful path is `pending -> callback_received -> exchanging -> succeeded`.

Other terminal attempt states are `failed`, `cancelled`, `expired`, and `outcome_unknown`, and no terminal attempt can become pending or succeed later.

Duplicate callbacks for a terminal successful attempt return the stored safe completion result without exchanging the code again, while duplicate or late callbacks for any other terminal attempt do not mutate connection state.

When the callback code may have been redeemed but the token response or commit is ambiguous, the attempt becomes `outcome_unknown` and the candidate cannot activate rather than assuming that retrying the code is safe.

An initial connection requires fresh authorization; a replacement attempt preserves the previous grant only while that grant remains independently valid.

## Credential envelope and refresh state machines

A credential envelope follows `candidate -> current -> retired -> erased` on a successful replacement path.
A candidate exists only in restricted protocol processing; it cannot authorize execution and is persisted encrypted only when staging is necessary.
Failed or abandoned candidates become `cleanup_only` for bounded revocation or `erased` when no cleanup is possible.
A current envelope may become `quarantined` after ambiguous renewal, invalid authorization, or database recovery; quarantined material cannot execute or refresh.
A current, retired or quarantined envelope may become `cleanup_only` after disconnect; only the restricted revocation worker may decrypt it.
Retired, quarantined and cleanup-only envelopes become erased when their retention/cleanup obligation ends; erased means no live usable secret reference, not a claim that encrypted backup bytes vanished instantly.
Only a current envelope on a ready connection with matching epoch/revision and valid provider expiry may authorize a new dispatch intent.
Expiry is credential metadata evaluated before use, not a second overlapping lifecycle state: renew through the declared policy or move the connection to reauthorization_required.
Atomic transactions install the new current version, retire the old version and update connection/attempt state together.

Refresh phases are `prepared -> dispatched -> committed`, with `failed` for a definitive no-replacement result and `outcome_unknown` for ambiguous renewal.
A refresh claim has one fence; terminal phases cannot become dispatched again, and a retry uses a fresh claim only when provider guarantees permit it.
An unsafe ambiguous refresh quarantines the current envelope and moves the connection to reauthorization_required.
A stale successful response cannot commit and its newly issued material is discarded or sent to restricted cleanup.

## Supported credential strategies

Every provider module declares each supported strategy and its lifecycle properties before registry construction, and registration fails if a capability requires an undeclared or unsupported strategy.

| Strategy | Storage and use | Expiry and recovery |
| --- | --- | --- |
| Expiring OAuth access credential without refresh token | Store encrypted access credential and grant metadata. | Calculate expiry from provider response and local receipt time, apply a provider-specific safety margin, and require fresh authorization after expiry. |
| Refreshable OAuth grant | Store access and refresh credentials as one encrypted version and refresh only through a fenced lease. | Apply returned token rotation atomically and require fresh authorization when refresh is terminally rejected or its result is ambiguous and unsafe to repeat. |
| Non-expiring bearer credential | Store encrypted credential only when the provider explicitly documents no expiry. | Do not infer indefinite validity from a missing expiry field; support operator or owner replacement and provider-side revocation. |
| API key | Store encrypted key, reviewed placement metadata, and optional operator expiry or rotation metadata. | Initial support excludes keys in URLs, including query parameters; providers requiring that placement are explicitly unsupported until a reviewed extension. |
| Client-credentials or other app/service grant | Store the resulting app-owned credential separately from the operator OAuth client secret used to obtain it. | Refresh under the app connection owner and never expose or use it for delegated identity. |
| Derived or exchanged credential | Derive from an already authorized parent credential when the provider supports a narrower or shorter-lived downstream credential. | Bind it to parent ID, logical revision, credentialVersion and authority epoch; invalidate local use and re-derive after any parent rotation, replacement, disconnect or expiry. |
| Unsupported or unclassifiable credential | Do not store or use it. | Return `UNSUPPORTED` with a safe explanation until the provider module documents lifecycle, storage, refresh, and revocation semantics. |

An access token with a missing or malformed `expires_in` is treated according to provider-specific documented behavior and never silently reclassified as non-expiring.

An API key or non-expiring token may be usable without refresh, but its external validity is not guaranteed by the local `ready` state.

Derived credentials are not a way to elevate privilege or switch identity, and the provider module must prove that their scope and subject are no broader than the parent authorization.

Their cache key and active validity fence include parent connection ID, logical revision, credentialVersion, authority epoch, audience, authorization and expiry.

An ordinary parent refresh changes credentialVersion and invalidates local child use even when the logical grant is unchanged; subsequent use must re-derive.

Local invalidation does not imply remote child-token revocation, and any future provider-specific exception requires a reviewed profile change.

The core does not accept resource-owner passwords or OAuth's resource-owner password credentials grant.

An interactive provider flow that cannot be safely bound to an authorization attempt and a delegated owner is unsupported until a provider module documents and reviews its complete lifecycle.

## OAuth authorization and safe callback experience

The initial supported OAuth subset requires PKCE S256; this is a deliberate compatibility restriction, not a claim that every provider supports it.

For supported browser authorization, the provider module uses the Authorization Code flow with PKCE `S256`, exact registered redirect URIs, a short-lived one-time state correlation value, and server-side callback handling.

The service stores only a hash of the random state value and binds it to one pending attempt, provider, owner, redirect URI, and expiry.

The PKCE verifier is encrypted while pending, used only for the token exchange, and erased when the attempt becomes terminal.

The callback handler validates the provider-specific issuer or fixed endpoint context, state, expiry, redirect URI, expected attempt state, and any required OpenID Connect nonce before exchanging a code.

The callback route accepts only the provider parameters required by its registered protocol adapter and rejects duplicate, oversized, malformed, or unexpected parameters.

The callback query string, authorization code, state value, provider error description, and token endpoint response are not written to access logs, analytics, browser storage, or referrer-bearing pages.

The authorization response page says only that authorization completed, was denied, expired, or could not be confirmed, and directs the user back to the configured app without displaying account identifiers or provider payloads.

The initiating app polls a protected authorization-attempt read method under the original trusted app and binding context to learn the safe outcome and connection readiness.

Callback state is correlation and one part of CSRF protection, never a substitute for the trusted adapter's initiating-browser continuity requirement; it cannot read a connection, select a capability, create a local identity, or authorize an execution.

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

The exact framework-independent types and signatures are owned by [contracts.md](contracts.md).
Connection operations are beginAuthorization, readAuthorizationAttempt, cancelAuthorization, listConnections, readConnection and disconnect; callback ingestion is a separate server-only protocol boundary.

`beginAuthorization` always creates or reauthorizes a delegated connection owned by the context's app and binding, and the optional connection ID is valid only for a connection already owned by that exact pair.

A disconnected target returns CONFLICT and requires a new connection ID; disabled targets remain blocked until operator action.

App/service credentials are provisioned through a separate operator-only control path and never through `beginAuthorization` on the browser-facing contract.

Browser list/read/disconnect operations are restricted to delegated connections of the exact app/binding; application secrets cannot be disconnected by a viewer.

An optional reviewed provider-mapped display label helps the owner distinguish connections; it is untrusted display text, never authority, and is excluded from logs and events.

Raw subject IDs, full provider profiles and unreviewed claims remain server-only.

Initial delegated acquisition supports the reviewed OAuth code subset; API-key or client-credentials app connections use operator provisioning, and delegated browser secret-entry flows are explicitly unsupported.

`handleProviderCallback` is a server adapter entrypoint without `TrustedContext`; it validates pending protocol correlation and the trusted adapter's continuity/current-binding evidence, then returns a generic callback page result without returning a connection or credential to the browser.

Shared types and provider-hook signatures are defined in [contracts.md](contracts.md); browser routes and SDK methods are defined in [http-sdk-events.md](http-sdk-events.md).

The HTTP adapter preserves raw protocol inputs and supplies fixed routing context; the provider protocol adapter validates them, and the connection module owns claims and persistence.

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
