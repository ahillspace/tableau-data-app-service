# Connections

The connections component owns definitions, application secrets, owner-bound connection credentials, setup, refresh, exchange and disconnect.
Its operator interface creates, patches, redefines and retires definitions, and sets write-only secrets.
Its app interface lists usable definitions, connects a personal account, sets an owner-bound credential and returns one request-scoped credential lease.
Shared types are in [contracts](contracts.md) and the finite protocol schema is in [provider protocol data](provider-protocol.md).

## Credential methods

| Method | Acquisition | Owner |
| --- | --- | --- |
| `authorization_code` | Browser authorization, optional PKCE and refresh. | Shared operator connection or personal viewer connection. |
| `client_credentials` | Token exchange using the definition's application authentication. | Shared connection. |
| `jwt_bearer` | Signed JWT assertion exchanged at the configured token endpoint. | Shared or personal connection key. |
| `signed_jwt_direct` | Signed JWT used directly on the native request. | Shared or personal connection key. |
| `static` | Write-only token or structured Basic credential. | Shared or personal connection. |
| `none` | No credential. | No connection required. |

OAuth client authentication is independently none, client_secret_basic, client_secret_post or private_key_jwt.
Private_key_jwt authenticates the application and is never confused with a JWT bearer grant or a direct native JWT.

## Definition changes

A definition has one stable ID, a definition generation, a mutation version, audience, ownership, HTTPS hosts and typed protocol data.
A template only prefills a definition and never changes it afterward.
Name, audience, scopes, enabled state, reauthorization interval and secret values change in place.
Every other configuration change requires redefinition, including hosts, endpoints, ownership and credential interpretation.
One transaction increments the generation, disconnects old connections, deletes their credentials and prevents old setup/exchange results from committing.
Retirement disables a definition permanently, ends all connections and preserves history without reusing its ID.
PATCH, PUT, retire and secret writes carry expectedVersion and reject stale versions with definition-conflict instead of overwriting concurrent changes.
Every definition or secret mutation increments the installation revision.
Replicas may cache definitions briefly, but checkout checks the current enabled state, audience and generations against Postgres.

## Secret entry and ownership

`clientSecret` and `signingPrivateKey` belong to the definition's OAuth application/client authentication, including private_key_jwt.
`signingSecret` belongs to the definition's inbound verification configuration, including Graph clientState.
Static tokens, Basic username/password, JWT bearer grant keys and direct JWT keys belong to a shared or personal connection, never to a definition's application secret slot.
This prevents a personal service-account import from overwriting the application key or another owner's credential.

```ts
type CredentialInput =
  | { kind: "token"; value: string }
  | { kind: "basic"; username: string; password: string }
  | { kind: "jwt"; privateKey: string; issuer: string; subject?: string; keyId?: string }
  | { kind: "import"; value: string }; // JSON text interpreted only by credentialImport
```

Create, PATCH and PUT accept write-only `secrets` and shared `credential` fields through the same connections owner.
The dedicated operation is `PUT /v1/admin/definitions/{id}/secrets` with `{expectedVersion, secrets?, credential?}`.
PATCH, PUT, retire and secret mutations require `expectedVersion` from the safe view and fail with 409 `definition-conflict` if it changed.
The dedicated endpoint requires at least one secret or credential field, including an explicit null.
Omission preserves a value; null explicitly clears it; an empty string is rejected and never means clear.
Clearing a required application secret is allowed and leaves setup incomplete, with affected authentication failing closed until replaced.
Clearing a shared credential uses local disconnect semantics and removes the cached/derived credential.
Only shared definitions accept operator `credential` input; the generic personal credential API remains owner-bound.
Secret input is limited to 64 KiB per value, measured in UTF-8 bytes, and all mutations validate completely before any persistence.
Secret values are sealed before persistence with their purpose and owning record binding, including a distinct application signing-key purpose.
Persist only selected imported credential fields, not the original JSON document.
Reads, errors, audit entries and logs contain no submitted values, provider token bodies, private keys, signatures or secret query text.
Reject all query parameters on create/update/redefine/secret-management routes, before request logging can include them.
Native credential placement in query parameters remains allowed by the configured protocol.

Within a transaction, rotation increments the authoritative secret/credential generation and installation revision, invalidates derived tokens and prevents an older exchange from committing.
Every checkout rechecks authoritative generations before reusing a derived token, even if the definition cache has not refreshed yet.
Keep protocol-derived tokens sealed in the owner connection; a connection row lock coordinates exchange/refresh across replicas.
The cache key covers definition generation, application-secret generation, credential generation, normalized scopes and effective audience.
The simplest implementation caches one current derived variant per connection and replaces it under that lock.
Already-issued authorization-code tokens retain their grant identity; client-secret rotation changes future token authentication and invalidates in-memory secret copies, not the viewer's consent.
Requests that already acquired a lease may finish; no new checkout after rotation commits may acquire superseded material.

## Connections and checkout

A shared definition has at most one active shared connection.
A personal definition has at most one active connection per verified identity.
A personal checkout never falls back to a shared connection or another identity.
A connection records its definition generation, credential generation, account metadata, granted scopes, authorization time, expiry and status.
Its status is connected, needs-authorization or disconnected.
The lease holds an opened credential for one request or one Job step and is never serialized.
Every checkout checks audience, enabled/retired state, connection generation and reauthorization interval before issuing a lease.
Missing required application material produces credential-unavailable; missing owner credentials produce not-connected.
No native request is sent when checkout fails.

## Setup readiness

The server returns setup with state ready, needs-setup, disabled or retired, finite missing paths and supported actions connect, set-credential and set-secrets.
For a personal definition this describes application prerequisites, not every viewer's connection state.
For a shared definition it also describes the shared credential prerequisites.
Missing paths are secrets.clientSecret, secrets.signingPrivateKey and credential.
An optional webhook signingSecret is displayed separately and never blocks native readiness or checkout.
Only authorization_code uses the browser connect flow.
The existing connect transaction, identity match, state, callback and generation checks remain authoritative.
Static or JWT credential input validates and seals a connection without making a provider business request.
Shared client_credentials establishes its connection when required application secrets are set and exchanges lazily at checkout.
None needs no connection.

## Refresh and exchange

A connection row lock coordinates refresh or exchange across replicas, with a bounded 30-second operation.
After acquiring the lock, recheck expiry and all authoritative generations before using or updating a credential.
Commit a rotated refresh token with its access token in the same write.
Cache derived tokens by definition/application-secret/credential generation, normalized scopes and effective audience.
Cache one current variant per connection to avoid an unbounded token cache.
A rejected grant becomes needs-authorization.
A definitive provider refusal leaves connection authority intact and returns refresh-failed or exchange-failed.
An ambiguous send returns refresh-uncertain or exchange-uncertain and preserves the old credential and outcome uncertainty.
The service does not automatically resend the business request, and refresh never moves the last explicit authorization time.

## Account lookup and disconnect

Lookup and revocation are fixed typed requests using the shared outbound transport.
Lookup failure is informational and cannot discard a valid credential.
Disconnect deletes local credential authority even when remote revocation fails.
A late refresh or exchange cannot resurrect a disconnected connection.
Failed revocation records only a safe code and never restores local access.

## Failure and recovery

| Failure | Result and recovery |
| --- | --- |
| Concurrent edit | definition-conflict; reload the safe view and review edits before resubmitting. |
| Definition changed during setup | definition-changed; start a new setup transaction. |
| Required secret missing or sealing key unavailable | credential-unavailable; restore the prerequisite without exposing its value. |
| Grant rejected | needs-authorization; reconnect the owner. |
| Refresh/exchange result unknown | Return the uncertain code and upstream provenance; preserve uncertainty. |
| Imported endpoint mismatch | Reject before persistence or network use. |
| Optional webhook secret missing | Refuse ingress while ordinary native checkout remains usable. |

## Extension

Add another supported provider as catalog data.
Add a genuinely new credential protocol once in the shared engine, with bounded inputs and concurrency/failure coverage.
Capabilities and Jobs can extend app behavior without becoming authentication or provider-routing branches.
