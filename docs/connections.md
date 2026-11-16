# Connections

The connections component turns provider accounts into credentials the router can use.
It owns provider types, connection definitions, connections, sealed credentials, setup flows, token refresh and the OAuth callback.
Shared types are in [contracts](contracts.md).

## Provider types

A provider type is code that knows how to obtain, refresh and place one kind of credential.

| Type | Credential | Obtained by |
| --- | --- | --- |
| `oauth2` | Access token, optional refresh token. | OAuth 2.0 authorization code with PKCE, with or without a client secret. |
| `static` | A token or API key. | Entered once, then stored sealed. |
| `none` | No credential. | Nothing; the router forwards to the definition's API hosts without adding a credential. |

Every type places its credential the way the definition says: an `Authorization` header with a scheme, a named header, or a named query parameter.

A preset is a provider type with provider-specific defaults and behavior filled in.
A preset may also register optional capabilities, Job handlers and an event source.
Presets are registered in `src/presets/index.ts`; [presets](presets.md) lists what a preset can add and the presets installed.

## Connection definitions

A connection definition is a database row.
It names everything the service needs to connect to and call one provider.

| Field | Meaning | Change rule |
| --- | --- | --- |
| `id` | Stable slug chosen by the operator; Data Apps refer to it. | Never changes. |
| `displayName` | Name shown to viewers and operators. | In place. |
| `type` | `oauth2`, `static`, `none`, or a preset. | Redefine. |
| `ownership` | `shared` or `personal`. | Redefine. |
| `apiHosts` | HTTPS base URLs the router may reach for this definition. | Redefine. |
| `authorizationEndpoint`, `tokenEndpoint` | OAuth endpoints, for `oauth2`. | Redefine. |
| `clientId` | OAuth client ID. | Redefine. |
| `clientSecret` | OAuth client secret, sealed; absent for public clients. | In place, through a secret link. |
| `tokenAuthentication` | How the client secret is sent to the token endpoint: `basic` (the default) or `post`. | Redefine. |
| `scopes` | Scopes requested at authorization. | In place; applies to new authorizations. |
| `presetOptions` | Fields the preset defines. | Redefine. |
| `credentialPlacement` | Where the router puts the credential. | Redefine. |
| `audience` | Trusted site IDs whose users may use the definition. | In place. |
| `reauthorizationInterval` | Optional maximum time between explicit authorizations. | In place. |
| `privateHosts` | Whether `apiHosts` may resolve to private addresses. | Redefine. |
| `enabled` | Whether new checkouts are allowed. | In place. |
| `signingSecret` | Event source signing secret, sealed, for presets with an event source. | In place, through a secret link. |
| `retired` | Whether the definition is retired. | Set by retirement. |
| `generation` | Incremented by every redefinition. | Set by the service. |

A definition is validated as a whole before it is stored.
A rejected definition returns every failing field with the rule it broke.
Sealed values are never returned; reads show only whether a secret is set and when it was set.

### Changing a definition

**In place.**
The change takes effect for the next checkout on every replica.
Existing connections are kept.
Removing a site from the audience stops that site's users at their next checkout.

**Redefine.**
One transaction increments the generation, disconnects every connection of the old generation, deletes their sealed credentials and records why.
A connect in progress for the old generation fails with `definition-changed`.
The definition ID stays the same, so Data Apps keep working once users reconnect.
A change to any endpoint or API host is always a redefinition, so a credential is never sent to a host it was not issued for.

**Retire.**
One transaction disables the definition, disconnects every connection, deletes their credentials and fails any connect in progress.
The definition and its connection history stay, and its ID can never be reused.

### Live pickup

Every definition write increments the installation revision in the same transaction.
Each replica caches definitions with the revision it loaded.
Before a checkout, a replica reads the current revision, at most once per second, and reloads definitions when the number has moved.
The checkout itself rechecks the definition's `enabled` flag and generation in the same query that reads the credential, so a stale cache never issues a credential for a disabled or redefined definition.

## Connections

A connection is one provider account attached to a definition generation.

- A **shared** definition has at most one connection, set up by an operator.
- A **personal** definition has at most one connection per identity, set up by that identity.

A connection records its definition ID and generation, its owner, a sealed credential, the provider account it belongs to for display, the scopes granted, the time of the last explicit authorization, the credential expiry, and a status.

| Status | Meaning |
| --- | --- |
| `connected` | Usable. |
| `needs-authorization` | The provider rejected the grant on refresh, the reauthorization interval passed, or the credential expired with no refresh token. |
| `disconnected` | Ended by the owner, an operator, a redefinition, a retirement, or a newer connection that replaced it; the credential is deleted. |

## Checkout

`checkout(principal, definitionId, signal)` returns a credential lease for one request.

1. The definition must be enabled and the identity's site must be in its audience.
2. A shared definition returns its shared connection.
   A personal definition returns the identity's own connection.
   A personal checkout never returns a shared connection, and no definition falls back to another.
3. The connection must be `connected`, of the current generation, and within its reauthorization interval.
4. An expired or nearly expired OAuth credential is refreshed first.

Failures return a stable code the SDK passes to the app:

| Code | Status | Meaning |
| --- | --- | --- |
| `definition-not-found` | 404 | No such definition. |
| `definition-disabled` | 403 | The definition is disabled or retired. |
| `not-in-audience` | 403 | The caller's site is not in the audience. |
| `not-connected` | 403 | There is no usable connection for the caller. |
| `needs-authorization` | 403 | The connection must be authorized again. |
| `definition-changing` | 503 | The definition is being changed; try again. |
| `credential-unavailable` | 503 | The sealing key for the credential is missing. |
| `refresh-failed` | 502 | The provider refused the refresh without rejecting the grant. |
| `refresh-uncertain` | 502 | The refresh outcome is unknown. |

The lease holds the opened credential in memory for that request only.

## Refresh

Refresh takes a row lock on the connection, rechecks the expiry, calls the token endpoint, and writes the new sealed credential before releasing the lock, so concurrent requests on any replica refresh once.
A rotated refresh token is stored in the same write.
If the token endpoint rejects the grant, the connection becomes `needs-authorization`.
If the provider refuses the refresh for another reason, the request fails with `refresh-failed` and the connection is unchanged.
If the outcome is unknown, such as a timeout after sending, the old credential is kept and the request fails with `refresh-uncertain`; the next checkout tries again.
Refresh never moves the time of the last explicit authorization.

## Setup flows

### OAuth

1. The SDK, with an app session, asks to connect a personal definition, or the CLI, with an operator session, asks to connect a shared definition, and receives a connect transaction ID that expires after ten minutes.
2. A popup or browser opens the service's connect page for that transaction.
3. The page requires a sign-in session whose identity matches the transaction's identity, and fails with `identity-mismatch` otherwise.
   This stops one person from attaching their provider account to someone else's identity by sending a link.
4. The service redirects to the provider's authorization endpoint with PKCE, the definition's scopes and a `state` value.
5. The provider redirects to the one callback, `/v1/oauth/callback`, which looks up the transaction by `state` and again requires a matching sign-in session.
6. The service exchanges the code, rechecks that the definition generation has not changed, seals the credential and stores the connection.
7. The page tells its opener the transaction finished and closes; the SDK reads the connection status.

### Static credentials

- A personal static credential arrives from the SDK with an app session, however the app obtained it.
- A shared static credential arrives through a one-time secret link opened by an operator.
- The service stores it sealed, as given, and never returns it.
- A preset may look up the provider account for display; the lookup never blocks storing the credential.

### Secret links

Client secrets, signing secrets and shared static credentials are entered through a one-time secret link.
An operator tool asks for a link naming the definition and field: `clientSecret` for a definition with an OAuth client, `signingSecret` for a definition with an event source, or `credential` for a shared static definition.
The link opens a service page at `/secret/:token` that requires a sign-in session belonging to an operator, takes the value in a form, seals it and is then spent.
A link expires after fifteen minutes and is bound to the definition generation it was issued for.
A value is 1 byte to 64 KiB.
The value never passes through the operator tool, chat or a terminal.

## Disconnect

An owner disconnects their own personal connection; an operator disconnects any connection.
Disconnecting deletes the sealed credential and, when the preset supports it, asks the provider to revoke the grant.
A failed revocation is recorded and does not keep the credential.

## Failure and recovery

| Failure | Behavior |
| --- | --- |
| Provider token endpoint down during setup | The transaction fails with the provider's error; nothing is stored. |
| Definition redefined or retired during setup | The connect fails with `definition-changed`; the user starts again. |
| Sealing key unavailable | Checkouts fail with `credential-unavailable` and name the key ID. |
| Refresh rejected | Connection becomes `needs-authorization`. |
| Refresh refused for another reason | Request fails with `refresh-failed`; connection unchanged. |
| Refresh outcome unknown | Old credential kept; request fails with `refresh-uncertain`. |

## Extension

A new preset is a `ProviderType` added to `src/presets/index.ts`: default endpoints and hosts, how to read the token response, optional account lookup, optional revocation, and optional capabilities, Job handlers and an event source.
Any provider that `oauth2`, `static` or `none` can describe needs no code.
