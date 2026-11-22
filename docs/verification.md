# Verification

This document describes retained verification coverage, validation gates and remaining live acceptance gaps.
The suite exercises the service against synthetic Tableau and provider servers with real Postgres and Redis.
Passing synthetic checks does not establish that real provider deployments behave identically.

## Automated tests

The following checks describe the retained correctness suite and its production-path fixtures.
Run `npm test` against real Postgres and real Redis where events are involved.
Tableau and providers are stood in for by local servers.
Test names carry the check's ID.
V17 measures bytes in flight on each leg rather than process memory, which tells a streaming router from a buffering one regardless of when garbage is collected.

| Check | Shows | Tests |
| --- | --- | --- |
| V1 | Bootstrap and settings validation list every failing field with its rule and no secret value. | `test/roles.test.ts` |
| V2 | Postgres connections verify the server certificate, and a mismatched CA fails startup. | `test/persistence.test.ts` |
| V3 | Tableau sign-in validates state, PKCE, nonce, ID token and current session, and the service publishes the client metadata document its client ID names, using a local stand-in for Tableau. | `test/identity.test.ts`, `test/http.test.ts` |
| V4 | Identity equality uses deployment, site ID and user ID; same username on two sites are two identities. | `test/identity.test.ts` |
| V5 | Bootstrap operator and trusted site bind to IDs on first sign-in and never match by name afterwards. | `test/identity.test.ts` |
| V6 | No Tableau role grants operator status. | `test/identity.test.ts` |
| V7 | First sign-in needs a matching proof and a single-use completion code, and a popup without an opener refuses. Restore issues a bearer from a valid restore cookie, and refuses after the sign-in limit or once the site is untrusted. | `test/identity.test.ts`, `test/http.test.ts` |
| V7a | Every operator route refuses a restored or app bearer. | `test/identity.test.ts`, `test/http.test.ts` |
| V8 | The sign-in limit is enforced and nothing but a Tableau sign-in moves it. | `test/identity.test.ts` |
| V9 | Sealed values open only with matching purpose and record ID. | `test/sealing.test.ts` |
| V10 | Definitions validate as a whole and report every failing field. | `test/connections.test.ts` |
| V11 | In-place changes keep connections; redefinition and retirement end them and delete credentials; definition IDs survive. | `test/connections.test.ts` |
| V12 | Two API replicas see a definition change on their next checkout. | `test/connections.test.ts` |
| V13 | Personal checkout never returns a shared connection. | `test/connections.test.ts` |
| V14 | Concurrent refreshes on two replicas call the token endpoint once. | `test/connections.test.ts` |
| V15 | A connect page refuses a sign-in cookie whose identity does not match the transaction. | `test/connections.test.ts`, `test/http.test.ts` |
| V16 | Native requests and responses pass through unchanged apart from the documented headers, and a provider response cannot pass for a service error or cause the SDK to resend. | `test/router.test.ts`, `test/http.test.ts` |
| V17 | Large uploads and downloads stream through the router without being buffered: bytes in flight on each leg stay bounded far below the body size. | `test/router.test.ts` |
| V18 | Destination checks refuse private and metadata addresses at socket time, including after DNS change. | `test/outbound.test.ts` |
| V19 | The router never retries and reports whether the provider may have received a request. | `test/outbound.test.ts` |
| V20 | Job admission is idempotent per submission key and never reports an uncommitted Job. | `test/jobs.test.ts` |
| V21 | Worker crash marks Jobs interrupted, and an attempt with an unknown outcome is never replayed unless the handler declares replay safe; the record keeps that uncertainty. | `test/jobs.test.ts` |
| V22 | Waiting Jobs release their slot and resume on a verified callback. | `test/jobs.test.ts`, `test/http.test.ts` |
| V23 | Job caps and retention windows are enforced; a success committed at or after the runtime deadline is not published, and a cancel recorded before an attempt's commit wins over its outcome, including an attempt that worker shutdown interrupts or lease recovery settles, and a success whose result cannot be stored. | `test/jobs.test.ts` |
| V24 | With events off, no Redis client is created; with Redis down, everything except events works. | `test/events.test.ts` |
| V25 | Configured event signatures are verified on original bytes; age checks apply only when the configured protocol supplies timestamps. | `test/slack.test.ts`, `test/events.test.ts` |
| V26 | No log line or error contains a secret value. | `test/platform.test.ts`, `test/roles.test.ts`, `test/http.test.ts` |
| V27 | The SDK minifies to under 15 KiB. | `test/sdk.test.ts` |

## Provider intake and console gates

These gates combine retained automated coverage with manual browser and terminal checks.
Use production API/CLI/browser/worker composition with synthetic Tableau/provider servers and real Postgres/Redis fixtures.
Browser checks must use the same HTTPS origin declared by the actual API.
Any certificate exception must be limited to the synthetic leaf key.

| Gate | Required evidence | State |
| --- | --- | --- |
| V28 | Actual API and CLI create/update/set/clear, piped/file/TTY/value conflicts, multiline keys, safe errors and no submitted values in output. Evidence: test/intake.test.ts, test/cli-secret.test.ts and test/http.test.ts; actual PTY no-echo/editing check. | Coverage retained; manual checks required. |
| V29 | Every acquisition method, client authentication and placement, nested and refresh mappings, HTTP 200 failures and data-only JSON import with endpoint mismatch. Evidence: test/intake-protocol.test.ts verifies provider-observed grants, independent RS256/ES256 signatures and normal/SSE calls; test/catalog.test.ts validates JSON sources. | Coverage retained. |
| V30 | Independent Postgres pools prove concurrent exchange, secret rotation/cache invalidation, disconnect races and stale generation commit rejection. Evidence: test/intake-protocol.test.ts and test/connections.test.ts use distinct pools and observed row-lock waits. | Coverage retained. |
| V31 | Exact/wildcard hosts, port/path/label boundaries, socket checks and synthetic service-account normal/SSE native calls through a generic Data App. Evidence: test/intake-protocol.test.ts, test/router.test.ts and test/outbound.test.ts; actual bundled-SDK browser shared/personal calls and normal/SSE delivery. | Coverage retained; manual checks required. |
| V32 | Slack, GitHub and Stripe original-byte fixtures; Graph basic clientState removal and validationToken echo; handshakes never fan out. Evidence: test/intake-webhook.test.ts exercises actual HTTP ingress and cross-replica Redis delivery; test/slack.test.ts retains catalog mapping coverage. | Coverage retained. |
| V33 | Actual console sign-in/consent/non-operator/session expiry, shared mutation API, CSRF/origin checks, both tabs, secret-safe forms and keyboard/narrow-layout behavior. Evidence: test/operator-auth.test.ts and test/console.test.ts; Chromium sign-in, denied/approved consent, both tabs and generic SDK. | Coverage retained; manual checks required. |
| V34 | Two-replica histogram/count aggregation, idempotent retry/out-of-order snapshots, restart identity, stale heartbeat and telemetry failure isolation. Evidence: test/operations.test.ts plus test/composition.test.ts with two actual API child processes, a worker, real ten-second flushes and the observed minute closing. | Coverage retained. |
| V35 | Fresh initial schema, obsolete interface removal, full tests, typecheck, lint and build under the required Node version. Evidence: Initial-schema fixtures, retained regression suite and package checks; built catalog JSON, local console assets and SDK size gate. | Coverage retained. |

The synthetic evidence covers finite fixtures, not universal vendor conformance or a proof that every possible secret value can never be disclosed.
The `test/intake-corrections.test.ts` fixtures cover production-path disable/secret staging, optional enrichment preparation failure, rejected shared OAuth readiness/reconnect, exact configured interval boundaries, activity statement counts and activity-only failure isolation.
The activity failure cases retain negative checks for expired, revoked and untrusted sessions.
No live provider keys, cloud IAM changes or unrelated credentials are needed for synthetic verification.

## Services and discovery

The service composition fixture starts the API with no providers, checks the enabled service's authenticated route and discovery action, and exercises the disabled state, an unavailable dependency and host cleanup.
The provider integration compiles a separate package against the public entry point, uses TLS provider fixtures and real Postgres, and checks per-definition options, credential ownership and detach and redefine races across two API instances.
The discovery checks cover public asset links, viewer filtering, operator removal, revoked or expired credentials and download bytes matching the public SHA-256.
A clean Linux client downloaded the CLI over test HTTPS, installed the archive with npm, ran help and used an isolated Secret Service keyring for the existing operator loopback sign-in.
The browser SDK and its declarations were downloaded and compiled outside the checkout, and the existing SDK popup test reads the viewer discovery projection after sign-in to the Tableau stand-in.

## Run the checks

Use the supported Node version and local Postgres/Redis setup in [running](running.md).
Run `npm ci`, `npm run typecheck`, `npm run lint` and `npm test`; the test command builds the application first.
The lint script covers both shipped examples.
Complete the manual PTY and browser checks in V28, V31 and V33 separately; automated tests do not replace them.
Record the revision and environment with any acceptance results.

## Not verified live

These have not yet been run against a deployed installation with a published Tableau Cloud Data App and real provider accounts:

- First use, then a silent return visit, a new tab and a second Data App on Tableau Cloud.
- The same journeys from Tableau Desktop.
- The restore cookie in a Cloud Data App frame, partitioned by the Tableau host, across two sites on one pod and a site on another pod.
- Shared and personal calls to the same provider from one Data App.
- Each catalog definition against its provider, including the particular configured webhook primitives.
- Adding, redefining and retiring a definition with no redeploy.
- CLI sign-in and operator recovery.
- A Job that outlives the page.
- Provider events reaching a Data App.
- Verified TLS to a hosted Postgres.
- Both supported development operating systems on the final integrated revision; prior runs do not prove a changed revision.
- A live GCS bucket with HMAC credentials has not been exercised.

## Known limitations

- The service does not verify which Tableau site the calling app runs on.
- Whether Tableau's central sign-in can reuse an existing Tableau Cloud session is unknown.
- Tableau Server is not supported.
- The data catalog installs no Job handler; Jobs require an explicit code extension.

## Relational Storage

`test/storage.test.ts` exercises opt-in startup and availability, two API replicas and real restricted PostgreSQL logins, Tableau stand-in identities, private workspace creation and creation replay, generated CRUD, migration replay and rollback, foreign-key navigation, exact decimals, atomic SQL function calls, row policies, role changes, revision repair, and operator suspension, transfer and purge.
`test/storage-toolkit.test.ts` covers viewer CLI handoff, workspace configuration and replay, request contracts, discovery artifacts, and the optional browser helper.
`test/files.test.ts`, `test/files-gcs.test.ts` and `test/files-local.test.ts` cover the S3-compatible, GCS and persistent local backends, workspace authority and signed URLs.
These automated journeys use synthetic Tableau identities.
Live Tableau Cloud and Desktop Storage sign-in and application use remain to be verified.
