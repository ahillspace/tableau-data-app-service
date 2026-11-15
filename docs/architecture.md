# Architecture

This document describes the service's topology, trust boundaries and components.
Each component has one owner, a narrow interface, the invariants it keeps, how it fails and recovers, and how it extends.
[Product](product.md) owns requirements; this document owns structure.
Shared types live in [contracts](contracts.md).

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
 Operator CLI / setup page ── bearer ──► operator API          Postgres (authoritative)
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

- **Owns:** configuration loading, logging with secret redaction, clock, structured errors, process roles, shutdown.
- **Interface:** `loadBootstrap()`, `log`, `ServiceError`, `clock.now()`.
- **Invariants:** a secret value is never written to a log line or an error message; configuration errors name the field and the rule.
- **Failure:** invalid configuration stops startup before the process accepts traffic, with every failing field listed.
- **Extension:** new bootstrap fields are added to one schema.

### Persistence

- **Owns:** the Postgres pool, migrations, transactions, and the installation revision.
- **Interface:** `db` (Kysely), `transaction(fn)`, `revision.bump(tx)`, `revision.current()`.
- **Invariants:** connections verify the server certificate; migrations run once, by one role, before either role serves.
- **Failure:** a lost database connection fails the request in flight; nothing is retried that may have committed.
- **Extension:** new tables arrive through new migrations owned by the component that owns the table.

### Sealing

- **Owns:** authenticated encryption of every stored secret.
- **Interface:** `seal(purpose, recordId, plaintext)`, `open(purpose, recordId, sealed)`.
- **Invariants:** a sealed value opens only with the same purpose and record ID; each sealed value names its key ID.
- **Failure:** a missing or wrong key fails closed and names the key ID, never the value.
- **Extension:** key rotation adds a key ID; old values reseal through the maintenance command.

### Identity

- **Owns:** deployments, trusted sites, verified Tableau sign-in, operators, sign-in sessions, app sessions and bearers, the app registry and the "verify app location" step.
- **Interface:** `beginSignIn`, `completeSignIn`, `issueAppSession`, `authenticate(bearer)`, `isOperator(identity)`.
- **Invariants:** an identity is a deployment, a site ID and a user ID; operator status comes only from the operators table; the last verified Tableau sign-in time is set only by a Tableau sign-in.
- **Failure:** a Tableau outage fails new sign-ins and leaves existing bearers working until they expire.
- **Extension:** a new deployment kind, such as Tableau Server, is a new deployment adapter.
- **Detail:** [identity](identity.md).

### Connections

- **Owns:** provider types, connection definitions and their generations, connections, sealed credentials, OAuth and static setup, token refresh, the generic OAuth callback.
- **Interface:** `definitions.*` for operators, `connect`, `disconnect`, `checkout(identity, definitionId)` returning a credential lease.
- **Invariants:** a credential is used only with the definition generation that issued it; a personal checkout never returns a shared connection; tokens are never returned to a caller.
- **Failure:** a refresh failure marks the connection as needing reauthorization and fails the request honestly.
- **Extension:** a provider preset is code that fills in a provider type and may add capabilities and an event source.
- **Detail:** [connections](connections.md).

### Router

- **Owns:** native request forwarding, destination checks, streaming.
- **Interface:** `route(identity, definitionId, request)` returning a streamed response.
- **Invariants:** the service adds the credential and removes nothing else from the native exchange except hop-by-hop headers and its own bearer; requests are never retried.
- **Failure:** an upstream failure returns its native status and body; a transport failure returns a service error that says whether the request may have reached the provider.
- **Extension:** a preset may declare extra API hosts or a credential placement.
- **Detail:** [routing](routing.md).

### Jobs

- **Owns:** Job admission, the durable queue, execution, external task waits, callbacks, results and retention.
- **Interface:** `submit`, `get`, `list`, `cancel`, and a handler registry for presets.
- **Invariants:** the Jobs table is the only queue; a submission key admits at most one Job per owner; an interrupted Job is never replayed unless its handler opts in.
- **Failure:** a worker crash leaves its Jobs claimable after their lease expires, marked as interrupted.
- **Extension:** a new handler is code registered under a provider preset.
- **Detail:** [jobs](jobs.md).

### Events

- **Owns:** event sources, verification of incoming events, Redis fan-out, server-sent event streams.
- **Interface:** `ingest(sourceId, request)`, `subscribe(identity, filter)`.
- **Invariants:** with events off no Redis client exists; an event reaches only subscribers allowed to use the definition it came from.
- **Failure:** a Redis outage stops events and leaves every other component working.
- **Extension:** a new event source is code registered under a provider preset.
- **Detail:** [events and SDK](events-sdk.md).

### HTTP surface

- **Owns:** Fastify routes, request parsing, error shapes, CORS, popup pages.
- **Interface:** the routes in [API](api.md).
- **Invariants:** API routes allow any origin, and only restore and redeem accept credentials; popup pages are served with no-store, no-referrer and a restrictive content security policy.
- **Failure:** every error uses one shape with a stable code.

### Browser SDK and CLI

- **Owns:** the Data App SDK and the operator command-line tool.
- **Interface:** described in [events and SDK](events-sdk.md) and [running](running.md).
- **Invariants:** the SDK keeps its bearer in memory only and stays small; the CLI stores its operator bearer in the host's credential store.

## Dependency direction

Platform and persistence sit at the bottom.
Sealing depends on platform.
Identity and connections depend on persistence and sealing.
Router depends on identity and connections.
Jobs and events depend on identity, connections and router.
The HTTP surface depends on every component and holds no business rules.
Presets depend only on the provider type interface in connections, and register into router, Jobs and events.

## Roles

| Role | Runs | Scales |
| --- | --- | --- |
| `api` | HTTP surface, router, sign-in, operator API, event ingest and streams. | Horizontally; no affinity is required. |
| `worker` | Job execution, retention cleanup, expired session cleanup. | Horizontally; claims rows with `FOR UPDATE SKIP LOCKED`. |
| `migrate` | Migrations, then exits. | Once per release. |
| `admin` | Host-local commands, including operator recovery and key rotation. | On demand. |

## Dependencies

Each runtime dependency has one job and is chosen because the job is security-sensitive or protocol-heavy enough that maintained code beats code written here.

| Package | Used by | Job |
| --- | --- | --- |
| `fastify` | HTTP surface | HTTP server, routing and streaming request bodies. |
| `kysely` and `pg` | Persistence | Typed queries and the Postgres driver with verified TLS. |
| `oauth4webapi` | Identity, connections | OAuth 2.0, PKCE and OpenID Connect validation. |
| `undici` | Router, connections | Outgoing HTTP with streaming and a socket-time destination check. |
| `ipaddr.js` | Router | Address range classification for destination checks. |
| `zod` | Platform, connections | Validation of settings, bootstrap and definitions, on the server only. |
| `canonicalize` | Jobs | Canonical JSON for submission key comparison. |
| `redis` | Events | Publish and subscribe, loaded only when events are on. |
| `@napi-rs/keyring` | CLI | Stores the operator bearer in the system credential store. |

The browser SDK has no runtime dependencies.
Development uses `typescript`, `esbuild`, `@biomejs/biome`, `@types/node`, `@types/pg` and Node's built-in test runner, with tests running against the developer's installed Postgres and Redis.
