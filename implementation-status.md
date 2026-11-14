# Implementation and evidence inventory

Status: local application implemented with actual deterministic and synthetic browser evidence.
No deployment, live provider configuration change or production capacity claim is made.
Architecture acceptance, executable evidence, independent code review and delivered user acceptance remain separate.
The [run guide](RUNNING.md) supplies setup, configuration and commands.

## Required surfaces and ownership

| Scope | Implemented behavior | Actual evidence | Remaining boundary |
| --- | --- | --- | --- |
| B00 foundation | Node LTS, strict TypeScript, Fastify, Kysely/Postgres, canonical public schemas, immutable migration owner and protected configuration. | `foundation.test.ts`, `application.test.ts`; real temporary Postgres, repeatable migrations, incompatible startup/configuration rejection and compiled process startup. | Deployment-specific database roles, TLS, ingress and aggregate capacity. |
| B02 authority | Stable deployment/site/user owners; fixed sessions; protected site registry; personal ownership across apps; explicit shared audiences; coherent ordinary snapshots with no writes; fresh post-lock authority and scoped mutation claims. | `authority.test.ts`, `operator.test.ts`, `credential-boundaries.test.ts`; actual Postgres races, revoke/expiry/parent checks and cross-owner denial. | Full mixed-load deployment sizing and live multi-platform acceptance. |
| B03 identity/session | Production Cloud OIDC validation and Server reference adapter; PKCE/state; correlated popup/proof handoff; one-use callback/redemption; partitioned HttpOnly restoration; fixed authentication maximum. | `sessions.test.ts`, `identity-adapters.test.ts`, `sdk-session.test.ts`, `sdk-browser.md`; actual TLS negative cases and Chromium reload/new-tab/browser-restart restoration. | Synthetic issuer evidence is not live Cloud/Server embedding or a registered Server client-type compatibility claim; initial silent-enrollment risk is explicitly deferred below. |
| B04 credentials | One writer for static/local/remote import, OAuth, renewal and operator publication; exact revision fences; uncertainty; known-account continuity; atomic credential/context/audience/source changes; request-scoped derived authenticators. | `authorizations.test.ts`, `renewals.test.ts`, `authority.test.ts`, `operator.test.ts`, `credential-boundaries.test.ts`; delayed exchanges, cancellation, two-service renewal races, expired claims and failed atomic retirement. | Live Slack app permissions/rotation and supported Server registration must be verified in their configured environments. |
| B05 native HTTP | Node/Undici streaming; approved destinations, pinned recipient/TLS verification, entrusted/protected headers, encoded bytes, GET/HEAD and no-follow carriers, progress stall handling, disposal and no business replay. | `transport.test.ts`, `http-core.test.ts`, Chromium native/image/media/download checks; real HTTP, TLS, nonreading sockets and cancelled upload producers. | Actual Tableau CSP/ingress/provider limits; arbitrary-size direct-to-disk browser download is not demonstrated. |
| B06 Jobs | Optional versioned declarations; semantic admission/idempotent recovery; encrypted input/result/task payloads; bounded scans/claims; local/external execution, callbacks, cancellation, uncertainty, retention and owner rediscovery. | `jobs.test.ts`, `jobs-external.test.ts`, `jobs-runtime.test.ts`, `sdk-jobs.test.ts`; actual Postgres/HTTP/child-process faults and full 100 MB resource experiment. | Capacity measurements are one controlled fixture, not a universal host/concurrency guarantee. |
| B07 Events | Optional Redis Pub/Sub and per-API authenticated SSE; current source/audience checks; exact ingress verification; bounded age/bytes/queues; independent slow-client disposal; source maintenance/retirement and Job hints. | `events.test.ts`, `events-lifecycle.test.ts`; actual Redis/HTTP/SSE outage/reconnect, maximum payload, source claim waits and nonreading clients. | Slack ships no event declaration; installed source providers supply native verification/setup hooks. Broker credentials/networks are host-owned. |
| B08 SDK/example | Memory bearer; fixed restoration; popup correlation; canonical discovery/connection/authorization APIs; ordinary invoke; explicit Jobs; lossy Events; native Response/body ownership; small Slack UI. | `sdk*.test.ts`, strict example typecheck and actual Chromium fixture described in `test/sdk-browser.md`. | Browser fixture does not establish live Tableau account switching, long-term sessions or all browser/storage policies. |
| B09 operation | Separate API and supervised worker, independent core maintenance, protected worker health, schema/config/key readiness, optional modules off, bounded shutdown and resumable offline rekey across every protected table. | `application.test.ts`, `jobs-runtime.test.ts`, `reencrypt.test.ts`; compiled processes start/drain, hung-worker faults, tamper/missing-key and interruption/resume coverage. | Real hosting/autorestart exclusion, backup restore, compatible rolling deployment and aggregate mixed workload require deployment evidence. |

Test paths above are under `test/` unless stated otherwise.
A passing build or a schema/type inspection is not counted as a running application test.
Selected deliberate faults were applied only to isolated test copies: removing the local-import generation fence causes both competing publications to succeed and the race test fails; Jobs owner faults also exercise missing lease fencing and suppressed termination.

## HTTP and extension inventory

A01-A05/A07 use the implemented session routes, including inert launch GET, proof-bearing POST, callback, redemption and restoration.
A08-A10 discover enabled providers and current-owner/shared safe connections.
A11-A17 use durable provider authorization and current-owner connection lifecycle routes; A18 forwards native requests through the controlled transport.
A19 and A39 discover/invoke generic versioned capabilities using ordinary current request authority without Job writes.
A20-A24 and declared verified external callbacks are installed when accepting declarations or retained Job records require them.
A25/A26 expose optional SSE and verified provider ingress; A27 provides declared durable-task callbacks.
A06, A28-A30 and A38 remain retired and are not restored as convenience endpoints.
A31-A33 expose only the existing protected site registry role.
A34/A35 expose host/network-protected liveness and readiness; the worker has a separate health-only listener.
A36 provides personal static setup; operator static/OAuth setup uses a distinct protected role.
A37 is supported through SDK-authenticated fetch for app-owned image decoding, MediaSource byte ranges and a small app-owned browser download; there is no query bearer or direct private media navigation.

Trusted setup composition uses `Sources.associate` to verify an owner-bound source association and `SourceMaintenance` for bounded hooks/retirement.
There is no generic browser assertion that a source is verified or public API for its private verifier/context.
Source hooks and generic Job/capability declarations are installed trusted source code, never uploaded browser code or configuration-selected modules.
Production composition installs Slack with native static/OAuth authentication and proxy endpoints, and `capabilities: []`.
Test-only providers exercise the optional capabilities, Jobs and event source machinery.

## Validation commands and bounds

Run `npm run typecheck`, `npm run typecheck:example`, `npm run lint`, `npm run build` and `REDIS_SERVER=/absolute/redis-server npm test`.
The final integrated standard suite passed 75 tests with no failures, cancellations or skips on Node 26.13.1.
Both strict typechecks, Biome and the production build also passed.
The standard suite starts actual isolated Postgres, Redis, HTTP/TLS and child processes; it does not depend on a shared database or broker.
The browser procedure is documented in [browser verification](test/sdk-browser.md), and the 100 MB controlled experiment is `test/jobs-resource.ts`.
The resource experiment exercises input canonicalization, encryption, Postgres publication, execution, result encryption and authenticated read, using 2.2 GB preparation capacity and one test execution slot.
Observed RSS was about 1.80 GB; this is a recorded fixture measurement and requires separate host/control headroom and workload validation.
Synthetic Chromium uses the production Cloud adapter and SessionService with a test HTTPS OIDC issuer; initial and deliberate subsequent login exchange tokens, while restore starts no extra identity exchange.
It also verifies spoofed popup rejection, unavailable opaque localStorage, native carriers/cancellation/late failure, image decode, video range seek and a small saved download.
The historical published Cloud experiment remains limited to the exact live observation documented in the access specification.

## Explicit residual risk and live limits

The user explicitly deferred initial cross-client silent-enrollment hardening and retained functional established login.
An attacker controlling an initiation proof can arrange a victim's silent Tableau login into that transaction and redeem the session from the attacker's client.
PKCE/state, expected popup/window/proof correlation, callback cookie matching, one-use redemption and fixed restoration protections remain implemented, but they do not solve that deferred risk.
No extra confirmation screen, ancestry helper or browser restriction is added.

No synthetic identity can be selected through production configuration.
Cloud and Server are implemented through distinct supported protocol contracts, but live Server service-client registration compatibility and complete live Cloud/Server Data App journeys remain unverified.
Live Slack credentials were not available for acceptance; deterministic static/OAuth/rotation behavior uses controlled upstreams.
No arbitrary ordinary response cap, tenancy, rate shaping, quota, fixed product execution-slot count or backend consumer is introduced.
