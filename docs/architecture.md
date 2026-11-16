# Architecture

This document describes the service's topology, trust boundaries and components.
Each component lists what it owns, its interface, the invariants it keeps, how it fails and recovers, and where it extends.
Shared types are in [contracts](contracts.md).

## Topology

```text
 Tableau Cloud / Desktop                         Service installation
 ┌──────────────────────────┐        ┌──────────────────────────────────────────────┐
 │ Data App frame           │ bearer │ API role (N replicas)                        │
 │  app code + browser SDK ─┼────────┼─► router, sign-in, operator API, Jobs API,   │
 │                          │        │   event streams, provider callbacks          │
 └──────────┬───────────────┘        │                                              │
            │ window.open            │ Worker role (N replicas)                     │
 ┌──────────▼───────────────┐        │   Job execution, maintenance                 │
 │ Service popup            │ cookie │                                              │
 │  (service origin)       ─┼────────┼─► sign-in session, provider connect          │
 └──────────────────────────┘        └──────┬───────────────────────┬───────────────┘
                                            │                       │
 Operator CLI / tools ─── bearer ──► operator API          Postgres (authoritative)
                                            │                  Redis (events only, optional)
                                            ▼
                                  Provider APIs, Tableau sign-in and REST API
```

The API and worker roles are one codebase started with a role argument.
Both scale to several replicas.
Postgres is the only authoritative store.
Redis carries live events only and is absent when events are off.

## Trust boundaries

| Boundary | What crosses it | What the service relies on |
| --- | --- | --- |
| Data App frame to API | Restore cookie on restore and redeem only; bearer on everything else. | The restore cookie or the bearer; the calling origin is never trusted and is usually opaque. |
| Popup to API | First-party sign-in cookie, form posts, OAuth redirects. | The cookie on the service origin, and PKCE and `state` for every redirect. |
| Operator tools to API | Operator bearer. | The bearer, issued only to a named operator after a verified Tableau sign-in. |
| API to Tableau | Authorization code exchange, OpenID Connect validation, current-session lookup. | Tableau's signed responses over verified TLS. |
| API and worker to providers | Native requests carrying sealed credentials once opened. | Definition API hosts, destination checks at socket time, verified TLS. |
| Provider to API | OAuth callbacks, Job callbacks, event deliveries. | `state` for OAuth; per-source verification for callbacks and events. |
| Host to service | Bootstrap configuration, sealing key, recovery command. | Host access; nothing on the host holds a provider secret in plain text. |

The service does not trust or verify which Tableau site the calling app runs on.
See [identity](identity.md#verify-app-location).

## Components

Components are listed in dependency order; a component depends only on components above it.

### Platform

- **Owns:** settings and bootstrap loading, structured logging with secret redaction, the clock, structured errors, outbound HTTP with destination checks.
- **Interface:** `loadSettings()`, `loadBootstrap(path)`, `Log`, `ServiceError`, the `Clock` type, `Outbound`.
- **Invariants:** a secret value is never written to a log line or an error message; configuration errors name every failing field and its rule.
- **Failure:** invalid configuration stops startup before the process accepts traffic, with every failing field listed.
- **Extension:** a new setting or bootstrap field is added to one schema.

### Persistence

- **Owns:** the Postgres pool, migrations, transactions, the installation revision and the audit log.
- **Interface:** `openDatabase()`, `migrate(db)`, `assertSchemaCurrent(db)`, `transaction(db, fn)`, `bumpRevision(tx)`, `currentRevision(db)`, `writeAudit()`.
- **Invariants:** connections verify the server certificate; migrations run only in the `migrate` role, and every other role refuses to start when the schema is behind.
- **Failure:** a lost database connection fails the request in flight; nothing that may have committed is retried.
- **Extension:** new tables arrive through new migrations owned by the component that owns the table.

### Sealing

- **Owns:** authenticated encryption of every stored secret, and resealing under a new key.
- **Interface:** `Sealer.seal(purpose, recordId, plaintext)`, `Sealer.open(purpose, recordId, sealed)`, `reseal(db, sealer)`.
- **Invariants:** a sealed value opens only with the same purpose and record ID; each sealed value names its key ID.
- **Failure:** a missing or wrong key fails closed and names the key ID, never the value.
- **Extension:** key rotation adds a key ID; `tdas-admin reseal` moves every value to the current key.

### Identity

- **Owns:** deployments, trusted sites, verified Tableau sign-in, operators, sign-in sessions, app sessions and bearers, the app registry and the "verify app location" step.
- **Interface:** `beginTableauSignIn`, `completeTableauSignIn`, `startAppSignIn`, `issueCompletionCode`, `redeemAppSignIn`, `restore`, `authenticate(bearer)`, `authenticateOperator(bearer)`, `beginOperatorSignIn`, `approveOperatorSignIn`, `redeemOperatorCode`, `revokeSessions`, and the directory of sites and operators.
- **Invariants:** an identity is a deployment, a site ID and a user ID; operator status comes only from the operators table; the last verified Tableau sign-in time is set only by a Tableau sign-in.
- **Failure:** a Tableau outage fails new sign-ins and leaves existing bearers working until they expire.
- **Extension:** a deployment kind is a `DeploymentAdapter` with `authorizationUrl` and `complete`; `tableau-cloud` is the one adapter.
- **Detail:** [identity](identity.md).

### Connections

- **Owns:** provider types, connection definitions and their generations, connections, sealed credentials, OAuth and static setup, secret links, token refresh, the OAuth callback and disconnect.
- **Interface:** `DefinitionStore` (`create`, `patch`, `redefine`, `retire`) for operators, `listForApp`, `startConnect`, `beginConnect`, `completeConnect`, `setPersonalCredential`, `createSecretLink`, `disconnectOwn`, `disconnectAny`, `checkout(caller, definitionId, signal)` returning a credential lease.
- **Invariants:** a credential is used only with the definition generation that issued it; a personal checkout never returns a shared connection; credentials are never returned to a caller.
- **Failure:** a refresh the provider rejects because the grant is gone marks the connection `needs-authorization`; any other refresh failure fails the request and leaves the connection as it was.
- **Extension:** a provider preset is a `ProviderType` in code that fills in defaults and may add capabilities, Job handlers and an event source.
- **Detail:** [connections](connections.md).

### Router

- **Owns:** native request forwarding, capability calls, API host selection and streaming.
- **Interface:** `NativeRouter.forward(request)` returning a streamed response, and `NativeRouter.capability(...)`.
- **Invariants:** the router sets the credential and removes only hop-by-hop headers and the service's own headers and cookies; requests are never retried.
- **Failure:** a provider's own error returns its native status and body; a transport failure returns a service error that says whether the request may have reached the provider.
- **Extension:** a preset declares its API hosts, credential placement and capabilities.
- **Detail:** [routing](routing.md).

### Jobs

- **Owns:** Job admission, the durable queue, execution, external task waits, callbacks, results and retention.
- **Interface:** `JobService` (`submit`, `get`, `listOwn`, `list`, `result`, `cancelOwn`, `cancelAny`, `callback`) and `JobWorker`; handlers come from provider types' `jobHandlers`.
- **Invariants:** the Jobs table is the only queue; a submission key admits at most one Job per owner and handler; an attempt with an unknown outcome is never replayed unless its handler declares replay safe.
- **Failure:** after a worker crash its leases expire, and each running Job is retried when its handler declares replay safe, and otherwise ends `interrupted`, or `cancelled` when a cancel was recorded.
- **Extension:** a new handler is code in a provider type's `jobHandlers`.
- **Detail:** [jobs](jobs.md).

### Events

- **Owns:** event sources, verification of incoming deliveries, Redis fan-out, server-sent event streams.
- **Interface:** `EventService.ingest(definitionId, delivery)`, `EventService.open(principal, definitionIds, sink)`.
- **Invariants:** with events off no Redis client exists; an event reaches only streams whose identity's site is in the audience of the definition it came from.
- **Failure:** a Redis outage stops event fan-out and leaves every other component serving.
- **Extension:** a new event source is code in a provider type's `eventSource`.
- **Detail:** [events and SDK](events-sdk.md).

### HTTP surface

- **Owns:** Fastify routes, request parsing, error shapes, CORS, cookies and service pages.
- **Interface:** the routes in [API](api.md).
- **Invariants:** API routes allow any origin, and only restore and redeem accept credentials; service pages are served with no-store, no-referrer and a restrictive content security policy.
- **Failure:** every error uses one shape with a stable code.

### Browser SDK and CLI

- **Owns:** the Data App SDK, the operator command-line tool `tdas` and the host command `tdas-admin`.
- **Interface:** described in [events and SDK](events-sdk.md) and [running](running.md).
- **Invariants:** the SDK keeps its bearer in memory only and stays small; `tdas` stores its operator bearer in the system credential store.

## Dependency direction

Platform and persistence sit at the bottom.
Sealing depends on platform.
Identity and connections depend on persistence and sealing.
Router depends on identity and connections.
Jobs and events depend on identity and connections.
The HTTP surface depends on every component and holds no business rules.
Presets depend only on the provider type interface in connections, and the router, Jobs and events read their capabilities, handlers and event sources from it.

## Roles

| Role | Runs | Scales |
| --- | --- | --- |
| `api` | HTTP surface, router, sign-in, operator API, event ingest and streams. | Horizontally; no affinity is required. |
| `worker` | Job execution, lease recovery, retention cleanup, expired session cleanup, and its own health routes. | Horizontally; claims rows with `FOR UPDATE SKIP LOCKED`. |
| `migrate` | Migrations, then exits. | Once per release. |
| `tdas-admin` | Host-local commands: operator recovery and resealing. A separate command, not a role of the service process. | On demand. |

## Dependencies

Each runtime dependency has one job, where the job is security-sensitive or protocol-heavy enough that maintained code beats code written here.

| Package | Used by | Job |
| --- | --- | --- |
| `fastify` | HTTP surface | HTTP server, routing and streaming request bodies. |
| `kysely` and `pg` | Persistence | Typed queries and the Postgres driver with verified TLS. |
| `oauth4webapi` | Identity | Tableau OAuth 2.0, PKCE and OpenID Connect validation. |
| `undici` | Platform outbound | Outgoing HTTP for the router, connections and presets, with streaming and a socket-time destination check. |
| `ipaddr.js` | Platform outbound | Address range classification for destination checks. |
| `zod` | Platform, identity | Validation of settings, bootstrap and Tableau responses, on the server only. |
| `canonicalize` | Jobs | Canonical JSON for submission key comparison. |
| `redis` | Events | Publish and subscribe, loaded only when events are on. |
| `@napi-rs/keyring` | CLI | Stores the operator bearer in the system credential store. |

The browser SDK has no runtime dependencies.
Development uses `typescript`, `esbuild`, `@biomejs/biome`, `@types/node`, `@types/pg` and Node's built-in test runner, with tests running against the developer's installed Postgres and Redis.
