# Verification

This document separates the current verification contract from evidence produced by an integrated implementation.
The provider-intake and console specification is authorized; specification convergence and prototype inspection do not establish implementation correctness or live acceptance.

## Automated tests

The following checks describe the established baseline suite and the behavior integration must preserve.
They are not a claim that the complete revised implementation has passed in this documentation change.
Run npm test against real Postgres and real Redis where events are involved.
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

These are required behavioral gates, pending evidence from the final integrated implementation.
Use production API/CLI/browser/worker composition with synthetic Tableau/provider servers and real Postgres/Redis fixtures.
Establish a distinguishing failing behavior before substantive deterministic changes where practical.

| Gate | Required evidence | State |
| --- | --- | --- |
| V28 | Actual API and CLI create/update/set/clear, piped/file/TTY/value conflicts, multiline keys, safe errors and no submitted values in output. | Pending integration. |
| V29 | Every acquisition method, client authentication and placement, nested and refresh mappings, HTTP 200 failures and data-only JSON import with endpoint mismatch. | Pending integration. |
| V30 | Independent Postgres pools prove concurrent exchange, secret rotation/cache invalidation, disconnect races and stale generation commit rejection. | Pending integration. |
| V31 | Exact/wildcard hosts, port/path/label boundaries, socket checks and synthetic service-account normal/SSE native calls through a generic Data App. | Pending integration. |
| V32 | Slack, GitHub and Stripe original-byte fixtures; Graph basic clientState removal and validationToken echo; handshakes never fan out. | Pending integration. |
| V33 | Actual console sign-in/consent/non-operator/session expiry, shared mutation API, CSRF/origin checks, both tabs, secret-safe forms and keyboard/narrow-layout behavior. | Pending integration. |
| V34 | Two-replica histogram/count aggregation, idempotent retry/out-of-order snapshots, restart identity, stale heartbeat and telemetry failure isolation. | Pending integration. |
| V35 | Fresh initial schema, obsolete interface removal, full tests, typecheck, lint and build under the required Node version. | Pending integration. |

A single final independent substantive review evaluates the integrated frozen revision after implementation checks pass.
Review findings are reported separately from implementation verification and user acceptance.
No live provider keys, cloud IAM changes or unrelated credentials are needed for synthetic verification.

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

## Known limitations

- The service does not verify which Tableau site the calling app runs on.
- Whether Tableau's central sign-in can reuse an existing Tableau Cloud session is unknown.
- Tableau Server is not supported.
- The data catalog installs no Job handler; Jobs require an explicit code extension.
