# Verification

These gates define what must be shown before each part of the service is called done.
Each gate records its status and, once run, the evidence and the commit it ran against.
Design convergence, implementation verification and user acceptance are tracked separately.

| Status | Meaning |
| --- | --- |
| Open | Not yet attempted. |
| Passed | Evidence recorded, with the commit it ran against. |
| Failed | Evidence recorded; work needed. |

## Automated gates

Run with `npm test` against a real Postgres, and Redis where noted.
Every automated gate passed on macOS at commit `4211986`, with 103 of 103 tests passing.
Each gate's evidence names the test file that shows it.
The Linux run has not been recorded yet.
V17 measures bytes in flight on each leg rather than process memory, because process memory depends on when garbage is collected and could not tell a buffering router from a streaming one.

| Gate | Shows | Status | Evidence |
| --- | --- | --- | --- |
| V1 | Bootstrap and settings validation list every failing field with its rule and no secret value. | Passed at `4211986` | `test/roles.test.ts` |
| V2 | Postgres connections verify the server certificate, and a mismatched CA fails startup. | Passed at `4211986` | `test/persistence.test.ts` |
| V3 | Tableau sign-in validates state, PKCE, nonce, ID token and current session, using a local stand-in for Tableau. | Passed at `4211986` | `test/identity.test.ts` |
| V4 | Identity equality uses deployment, site ID and user ID; same username on two sites are two identities. | Passed at `4211986` | `test/identity.test.ts` |
| V5 | Bootstrap operator and trusted site bind to IDs on first sign-in and never match by name afterwards. | Passed at `4211986` | `test/identity.test.ts` |
| V6 | No Tableau role grants operator status. | Passed at `4211986` | `test/identity.test.ts` |
| V7 | First sign-in needs a matching proof and a single-use completion code, and a popup without an opener refuses. Restore issues a bearer from a valid restore cookie, and refuses after the sign-in limit or once the site is untrusted. | Passed at `4211986` | `test/identity.test.ts`, `test/http.test.ts` |
| V7a | Every operator route refuses a restored or app bearer. | Passed at `4211986` | `test/identity.test.ts`, `test/http.test.ts` |
| V8 | The sign-in limit is enforced and nothing but a Tableau sign-in moves it. | Passed at `4211986` | `test/identity.test.ts` |
| V9 | Sealed values open only with matching purpose and record ID. | Passed at `4211986` | `test/sealing.test.ts` |
| V10 | Definitions validate as a whole and report every failing field. | Passed at `4211986` | `test/connections.test.ts` |
| V11 | In-place changes keep connections; redefinition and retirement end them and delete credentials; definition IDs survive. | Passed at `4211986` | `test/connections.test.ts` |
| V12 | Two API replicas see a definition change on their next checkout. | Passed at `4211986` | `test/connections.test.ts` |
| V13 | Personal checkout never returns a shared connection. | Passed at `4211986` | `test/connections.test.ts` |
| V14 | Concurrent refreshes on two replicas call the token endpoint once. | Passed at `4211986` | `test/connections.test.ts` |
| V15 | A connect page refuses a sign-in cookie whose identity does not match the transaction. | Passed at `4211986` | `test/connections.test.ts`, `test/http.test.ts` |
| V16 | Native requests and responses pass through unchanged apart from the documented headers, and a provider response cannot pass for a service error or cause the SDK to resend. | Passed at `4211986` | `test/router.test.ts`, `test/http.test.ts` |
| V17 | Large uploads and downloads stream through the router without being buffered: bytes in flight on each leg stay bounded far below the body size. | Passed at `4211986` | `test/router.test.ts` |
| V18 | Destination checks refuse private and metadata addresses at socket time, including after DNS change. | Passed at `4211986` | `test/outbound.test.ts` |
| V19 | The router never retries and reports whether the provider may have received a request. | Passed at `4211986` | `test/outbound.test.ts` |
| V20 | Job admission is idempotent per submission key and never reports an uncommitted Job. | Passed at `4211986` | `test/jobs.test.ts` |
| V21 | Worker crash marks Jobs interrupted, and an attempt with an unknown outcome is never replayed unless the handler declares replay safe; the record keeps that uncertainty. | Passed at `4211986` | `test/jobs.test.ts` |
| V22 | Waiting Jobs release their slot and resume on a verified callback. | Passed at `4211986` | `test/jobs.test.ts`, `test/http.test.ts` |
| V23 | Job caps and retention windows are enforced; a success committed at or after the runtime deadline is not published, and a cancel recorded before an attempt's commit wins over its outcome. | Passed at `4211986` | `test/jobs.test.ts` |
| V24 | With events off, no Redis client is created; with Redis down, everything except events works. | Passed at `4211986` | `test/events.test.ts` |
| V25 | Slack event signatures and ages are verified; stale or forged deliveries are refused. | Passed at `4211986` | `test/slack.test.ts`, `test/events.test.ts` |
| V26 | No log line or error contains a secret value. | Passed at `4211986` | `test/platform.test.ts`, `test/roles.test.ts`, `test/http.test.ts` |
| V27 | The SDK minifies to under 15 KB. | Passed at `4211986` | `test/sdk.test.ts` |

## Live gates

Run against a deployed installation with a published Tableau Cloud Data App and a real Slack workspace.

| Gate | Shows | Status |
| --- | --- | --- |
| L1 | First use, then a silent return visit, new tab and second Data App on Tableau Cloud. | Open |
| L2 | The same journeys from Tableau Desktop. | Open |
| L3 | The restore cookie works in a Cloud Data App frame and is partitioned by the Tableau host, checked with two sites on one pod and one site on another pod. | Open |
| L4 | Shared Slack bot calls and personal Slack user calls from one Slack app. | Open |
| L5 | Organization-wide Enterprise Grid install. | Open |
| L6 | Add, redefine and retire a definition with no redeploy. | Open |
| L7 | CLI sign-in and operator recovery. | Open |
| L8 | A Job that outlives the page. | Open |
| L9 | Slack events reach a Data App. | Open |
| L10 | Verified TLS to the hosted Postgres. | Open |

## Known limitations

- The service does not verify which Tableau site the calling app runs on.
- Whether Tableau's central sign-in can reuse an existing Tableau Cloud session is unknown.
- Tableau Server is not built.
- No production Job handler ships: Job handlers are optional per provider type and none is specified for Slack, so L8 needs a provider type that installs one.
