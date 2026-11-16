# Verification

This document lists what the automated tests show, what has not been checked against live services, and the service's known limitations.

## Automated tests

`npm test` runs these checks against a real Postgres, and a real Redis where events are involved.
Tableau and providers are stood in for by local servers.
Test names carry the check's ID.
V17 measures bytes in flight on each leg rather than process memory, which tells a streaming router from a buffering one regardless of when garbage is collected.

| Check | Shows | Tests |
| --- | --- | --- |
| V1 | Bootstrap and settings validation list every failing field with its rule and no secret value. | `test/roles.test.ts` |
| V2 | Postgres connections verify the server certificate, and a mismatched CA fails startup. | `test/persistence.test.ts` |
| V3 | Tableau sign-in validates state, PKCE, nonce, ID token and current session, using a local stand-in for Tableau. | `test/identity.test.ts` |
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
| V25 | Slack event signatures and ages are verified; stale or forged deliveries are refused. | `test/slack.test.ts`, `test/events.test.ts` |
| V26 | No log line or error contains a secret value. | `test/platform.test.ts`, `test/roles.test.ts`, `test/http.test.ts` |
| V27 | The SDK minifies to under 15 KiB. | `test/sdk.test.ts` |

## Not verified live

These have not yet been run against a deployed installation with a published Tableau Cloud Data App and a real Slack workspace:

- First use, then a silent return visit, a new tab and a second Data App on Tableau Cloud.
- The same journeys from Tableau Desktop.
- The restore cookie in a Cloud Data App frame, partitioned by the Tableau host, across two sites on one pod and a site on another pod.
- Shared Slack bot calls and personal Slack user calls from one Slack app.
- An organization-wide Enterprise Grid install.
- Adding, redefining and retiring a definition with no redeploy.
- CLI sign-in and operator recovery.
- A Job that outlives the page.
- Slack events reaching a Data App.
- Verified TLS to a hosted Postgres.
- The test suite on Linux; it has been run on macOS.

## Known limitations

- The service does not verify which Tableau site the calling app runs on.
- Whether Tableau's central sign-in can reuse an existing Tableau Cloud session is unknown.
- Tableau Server is not supported.
- No provider type installs a Job handler, so Jobs have nothing to run until one does.
