# Verification

These gates define what must be shown before each part of the service is called done.
Nothing here has been run; status is recorded per gate as work proceeds.
Design convergence, implementation verification and user acceptance are tracked separately.

| Status | Meaning |
| --- | --- |
| Open | Not yet attempted. |
| Passed | Evidence recorded, with the commit it ran against. |
| Failed | Evidence recorded; work needed. |

## Automated gates

Run with `npm test` on macOS and Linux against a real Postgres, and Redis where noted.

| Gate | Shows | Status |
| --- | --- | --- |
| V1 | Bootstrap and settings validation list every failing field with its rule and no secret value. | Open |
| V2 | Postgres connections verify the server certificate, and a mismatched CA fails startup. | Open |
| V3 | Tableau sign-in validates state, PKCE, nonce, ID token and current session, using a local stand-in for Tableau. | Open |
| V4 | Identity equality uses deployment, site ID and user ID; same username on two sites are two identities. | Open |
| V5 | Bootstrap operator and trusted site bind to IDs on first sign-in and never match by name afterwards. | Open |
| V6 | No Tableau role grants operator status. | Open |
| V7 | First sign-in needs a matching proof and a single-use completion code, and a popup without an opener refuses. Restore issues a bearer from a valid restore cookie, and refuses after the sign-in limit or once the site is untrusted. | Open |
| V7a | Every operator route refuses a restored or app bearer. | Open |
| V8 | The sign-in limit is enforced and nothing but a Tableau sign-in moves it. | Open |
| V9 | Sealed values open only with matching purpose and record ID. | Open |
| V10 | Definitions validate as a whole and report every failing field. | Open |
| V11 | In-place changes keep connections; redefinition and retirement end them and delete credentials; definition IDs survive. | Open |
| V12 | Two API replicas see a definition change on their next checkout. | Open |
| V13 | Personal checkout never returns a shared connection. | Open |
| V14 | Concurrent refreshes on two replicas call the token endpoint once. | Open |
| V15 | A connect page refuses a sign-in cookie whose identity does not match the transaction. | Open |
| V16 | Native requests and responses pass through unchanged apart from the documented headers. | Open |
| V17 | Large uploads and downloads stream with bounded memory. | Open |
| V18 | Destination checks refuse private and metadata addresses at socket time, including after DNS change. | Open |
| V19 | The router never retries and reports whether the provider may have received a request. | Open |
| V20 | Job admission is idempotent per submission key and never reports an uncommitted Job. | Open |
| V21 | Worker crash marks Jobs interrupted, with no replay unless the handler opts in. | Open |
| V22 | Waiting Jobs release their slot and resume on a verified callback. | Open |
| V23 | Job caps and retention windows are enforced. | Open |
| V24 | With events off, no Redis client is created; with Redis down, everything except events works. | Open |
| V25 | Slack event signatures and ages are verified; stale or forged deliveries are refused. | Open |
| V26 | No log line or error contains a secret value. | Open |
| V27 | The SDK minifies to under 15 KB. | Open |

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
