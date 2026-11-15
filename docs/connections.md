# Connections

The connections component turns provider accounts into credentials the router can use.
It owns provider types, connection definitions, connections, sealed credentials, setup flows, token refresh and the OAuth callback.
Requirements come from [product](product.md); shared types are in [contracts](contracts.md).

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
The first build ships one preset, `slack`.

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
| `scopes` | Scopes requested at authorization. | In place; applies to new authorizations. |
| `presetOptions` | Preset fields, such as Slack's `tokenMode`. | Redefine. |
| `credentialPlacement` | Where the router puts the credential. | Redefine. |
| `audience` | Trusted site IDs whose users may use the definition. | In place. |
| `reauthorizationInterval` | Optional maximum time between explicit authorizations. | In place. |
| `privateHosts` | Whether `apiHosts` may resolve to private addresses. | Redefine. |
| `enabled` | Whether new checkouts are allowed. | In place. |
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
One transaction increments the generation, disconnects every connection of earlier generations, deletes their sealed credentials and records why.
The definition ID stays the same, so Data Apps keep working once users reconnect.
A change to any endpoint or API host is always a redefinition, so a credential is never sent to a host it was not issued for.

**Retire.**
One transaction disables the definition, disconnects every connection and deletes their credentials.
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
| `needs-authorization` | A refresh failed, the reauthorization interval passed, or the provider revoked the grant. |
| `disconnected` | Ended by the owner, an operator, a redefinition or a retirement; the credential is deleted. |

## Checkout

`checkout(identity, definitionId)` returns a credential lease for one request.

1. The definition must be enabled and the identity's site must be in its audience.
2. A shared definition returns its shared connection.
   A personal definition returns the identity's own connection.
   A personal checkout never returns a shared connection, and no definition falls back to another.
3. The connection must be `connected`, of the current generation, and within its reauthorization interval.
4. An expired or nearly expired OAuth credential is refreshed first.

Failures return a stable code the SDK passes to the app: `definition-not-found`, `definition-disabled`, `not-in-audience`, `not-connected`, `needs-authorization`.
The lease holds the opened credential in memory for that request only.

## Refresh

Refresh takes a row lock on the connection, rechecks the expiry, calls the token endpoint, and writes the new sealed credential before releasing the lock, so concurrent requests on any replica refresh once.
A rotated refresh token is stored in the same write.
If the token endpoint rejects the refresh token, the connection becomes `needs-authorization`.
If the outcome is unknown, such as a timeout after sending, the old credential is kept and the request fails with `refresh-uncertain`; the next checkout tries again.
Refresh never moves the time of the last explicit authorization.

## Setup flows

### OAuth

1. The SDK, with an app session, or the CLI, with an operator session, asks to connect a definition and receives a connect transaction ID.
2. A popup or browser opens the service's connect page for that transaction.
3. The page requires a sign-in session whose identity matches the transaction's identity, and fails with `identity-mismatch` otherwise.
   This stops one person from attaching their provider account to someone else's identity by sending a link.
4. The service redirects to the provider's authorization endpoint with PKCE, the definition's scopes and a `state` value.
5. The provider redirects to the one callback, `/v1/oauth/callback`, which looks up the transaction by `state`.
6. The service exchanges the code, rechecks that the definition generation has not changed, seals the credential and stores the connection.
7. The page tells its opener the transaction finished and closes; the SDK reads the connection status.

### Static credentials

- A personal static credential arrives from the SDK with an app session, however the app obtained it.
- A shared static credential arrives through a one-time secret link opened by an operator.
- The service stores it sealed, as given, and never returns it.
- A preset may look up the provider account for display; the lookup never blocks storing the credential.

### Secret links

Client secrets and shared static credentials are entered through a one-time secret link.
The CLI or setup page asks for a link naming the definition and field.
The link opens a service page that requires an operator sign-in session, takes the value in a form, seals it and is then spent.
A link expires after fifteen minutes.
The value never passes through the CLI, the setup page's code, chat or a terminal.

## Disconnect

An owner disconnects their own personal connection; an operator disconnects any connection.
Disconnecting deletes the sealed credential and, when the preset supports it, asks the provider to revoke the grant.
A failed revocation is recorded and does not keep the credential.

## Slack preset

- `type: slack`, `presetOptions.tokenMode`: `bot` or `user`.
- API host `https://slack.com/api`; OAuth endpoints `https://slack.com/oauth/v2/authorize` and `https://slack.com/api/oauth.v2.access`.
- Bot mode requests `scope` and stores the bot token; user mode requests `user_scope` and stores the installing user's token.
- One Slack app can back a shared bot definition and a personal user definition, since one install returns both tokens.
- The account recorded is the workspace, or the enterprise for an organization-wide Enterprise Grid install that returns no team.
- Static credentials are accepted in either mode, and `auth.test` names the workspace for display.
- Token rotation is supported when the Slack app enables it.
- An optional sealed signing secret enables the [Slack event source](events-sdk.md#slack-event-source).

## Failure and recovery

| Failure | Behavior |
| --- | --- |
| Provider token endpoint down during setup | The transaction fails with the provider's error; nothing is stored. |
| Definition redefined during setup | The callback fails with `definition-changed`; the user starts again. |
| Sealing key unavailable | Checkouts fail with `credential-unavailable` and name the key ID. |
| Refresh rejected | Connection becomes `needs-authorization`. |
| Refresh outcome unknown | Old credential kept; request fails with `refresh-uncertain`. |

## Extension

A new preset is code implementing the provider type interface: default endpoints and hosts, how to read the token response, optional account lookup, optional revocation, and optional capabilities, Job handlers and an event source.
Any provider that `oauth2`, `static` or `none` can describe needs no code.
