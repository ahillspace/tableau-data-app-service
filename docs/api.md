# API

All routes are under the service's public origin.
JSON routes accept and return `application/json`, and errors use the [error shape](contracts.md#errors).
Authenticated app and CLI routes take `Tableau-Service-Authorization: Bearer <token>`.
App bearer routes answer CORS for any origin, echo the requested method and headers on preflight with a ten-minute max age, allow private network access, and expose every response header.
Cookie-authenticated admin routes are same-origin only and do not enable credentialed cross-origin admin CORS.
App routes marked credentialed echo the request's `Origin`, including `null`, and allow credentials; every other app API route is called without credentials.
Responses other than native streams carry a no-store cache policy and `X-Content-Type-Options: nosniff`.
Pages are top-level service windows that read the sign-in cookie; they are served with no-store, no-referrer and a restrictive content security policy.

## Discovery and release assets

| Method and path | Auth | Owner | Purpose |
| --- | --- | --- | --- |
| `GET /v1/discovery` | Optional bearer | HTTP | Discover product versions, installer and SDK links, with installation details authorized by the bearer. |
| `GET /v1/tools/tdas-cli-{version}.tgz` | None | HTTP | Download the CLI archive identified by discovery. |
| `GET /v1/tools/sdk/{file}` | None | HTTP | Download the browser SDK or its public declaration file using the discovery links. |
| `GET /v1/tools/contracts/operator.d.ts` | None | HTTP | Fetch the declaration used by the SDK's credential input type. |
| `GET /v1/tools/example/index.html` | None | HTTP | Open the browser SDK discovery example. |
| `GET /v1/tools/specification.html` | None | HTTP | Read the release's product and usage documentation. |

An anonymous response contains no installation inventory.
A browser app bearer sees visible definitions and native links, caller connection readiness, attached operations with typed contracts and relevant service actions.
An operator bearer sees the installed package versions, safe definitions, attachment states, available presets and deployed service states.
The service checks current operator membership.
A malformed, expired or revoked bearer receives 401, and a removed operator with a live bearer receives 403.
Authenticated discovery is private and no-store.
Discovery does not establish a provider connection or check an upstream endpoint.

## App sign-in

| Method and path | Auth | Owner | Purpose |
| --- | --- | --- | --- |
| `POST /v1/app-sign-ins` | None | Identity | Start an app sign-in with app ID, attribution and proof hash. |
| `GET /sign-in/{transactionId}` | Cookie | Identity | Popup page: Tableau sign-in if needed, then submits itself when it has an opener. |
| `POST /sign-in/{transactionId}` | Cookie | Identity | Issues the completion code and posts it to the opener. |
| `POST /v1/app-sign-ins/{transactionId}/redeem` | Credentialed | Identity | Redeem completion code and proof for a bearer; sets the restore cookie. |
| `POST /v1/session/restore` | Credentialed, restore cookie | Identity | Restore an app session with no prompt. |
| `GET /v1/session` | Bearer | Identity | Current identity, app ID and expiry. |

## Tableau sign-in

| Method and path | Auth | Owner | Purpose |
| --- | --- | --- | --- |
| `GET /tableau/sign-in` | None | Identity | Start Tableau sign-in for a page flow; shows a pod chooser when there are several deployments, then redirects to Tableau. |
| `GET /tableau/client.json` | None | Identity | The service's OAuth client metadata document; its URL is the client ID. |
| `GET /tableau/callback` | Transaction cookie | Identity | Tableau's redirect; sets the sign-in cookie. |
| `GET /tableau/signed-in` | Cookie | Identity | Confirms the sign-in when no other page asked for it. |

## Operator sign-in

| Method and path | Auth | Owner | Purpose |
| --- | --- | --- | --- |
| `GET /operator-sign-in` | Cookie | Identity | Operator consent page, opened by the CLI with its loopback `redirect_uri`, `code_challenge` and `state`, or by a browser tool with `mode=popup`. |
| `POST /operator-sign-in` | Cookie and consent token | Identity | Approve or deny; on approval issues a one-time code to the loopback address or the opener. |
| `POST /v1/operator-sign-ins/token` | Code and verifier | Identity | Redeem the one-time code for an operator bearer. |

## Definitions and connections for apps

| Method and path | Auth | Owner | Purpose |
| --- | --- | --- | --- |
| `GET /v1/definitions` | Bearer | Connections | Definitions the identity's site may use, with ownership, setup options, the caller's connection status and account. |
| `POST /v1/definitions/{id}/connect` | Bearer | Connections | Start OAuth connect for a personal definition; returns `{kind:"redirect",transactionId,url,expiresAt}`. A shared definition answers `shared-definition` with status 409. |
| `GET /connect/{transactionId}` | Cookie | Connections | Connect page; requires the transaction's identity and redirects to the provider. |
| `GET /v1/oauth/callback` | Cookie and `state` | Connections | The one provider OAuth callback; requires a sign-in session for the connecting identity. Not a CORS route. |
| `PUT /v1/definitions/{id}/credential` | Bearer | Connections | Store a typed personal static/JWT credential or mapped JSON import. |
| `DELETE /v1/definitions/{id}/connection` | Bearer | Connections | Disconnect the caller's personal connection. |

## Native routing and capabilities

| Method and path | Auth | Owner | Purpose |
| --- | --- | --- | --- |
| `ANY /v1/native/{definitionId}` and `ANY /v1/native/{definitionId}/{path}` | Bearer | Router | Forward a native request. |
| `POST /v1/capabilities/{definitionId}/{name}` | Bearer | Router | Call a named operation attached to this definition with `{"input": ...}` and receive `{"result": ...}`. |

## Jobs

| Method and path | Auth | Owner | Purpose |
| --- | --- | --- | --- |
| `POST /v1/jobs` | App bearer | Jobs | Submit with handler, definition ID, input and submission key; 201 when created, 200 when the key already names the Job. |
| `GET /v1/jobs` | Bearer | Jobs | List the caller's Jobs, filtered by `state` and `limit`. |
| `GET /v1/jobs/{id}` | Bearer | Jobs | Read a Job. |
| `GET /v1/jobs/{id}/result` | Bearer | Jobs | Read a Job's result. |
| `POST /v1/jobs/{id}/cancel` | Bearer | Jobs | Cancel. |
| `POST /v1/jobs/callbacks/{id}` | Callback verifier as bearer | Jobs | External task callback; answered with 202. |

## Events

| Method and path | Auth | Owner | Purpose |
| --- | --- | --- | --- |
| `GET /v1/events/stream?definitions=a,b` | App bearer | Events | Server-sent event stream. |
| `POST /v1/events/ingest/{definitionId}` | Source verification | Events | Provider event delivery. |

With events off, both answer `events-off` with status 404.

## Operator API

Every operator route needs a current operator session, carried as a CLI bearer or the protected same-origin console cookie; app and restored bearers are refused.
Cookie mutations additionally require exact Origin and X-TDAS-CSRF as described in [console](console.md).
These are the routes the CLI calls, and any other operator tool can call them the same way.

| Method and path | Purpose |
| --- | --- |
| `GET /v1/admin/definitions` | List definitions, including disabled and retired. |
| `GET /v1/admin/definitions/{id}` | Read one definition. |
| `POST /v1/admin/definitions` | Create a definition. |
| `PATCH /v1/admin/definitions/{id}` | Change in place; refuses fields that need a redefinition. |
| `PUT /v1/admin/definitions/{id}` | Redefine; returns the new generation and the number of connections ended. |
| `POST /v1/admin/definitions/{id}/retire` | Retire. |
| `PUT /v1/admin/definitions/{id}/secrets` | Atomically set/clear application secrets or a shared connection credential using expectedVersion; omission preserves a value. |
| `POST /v1/admin/definitions/{id}/connect` | Connect a shared definition: authorization_code returns `{kind:"redirect",transactionId,url,expiresAt}` for browser setup; client_credentials returns `{kind:"connected",definitionId,connectionId}` after local authorization, with exchange deferred until checkout. A personal definition answers `personal-definition` with status 409. |
| `GET /v1/admin/connections` | List connections, filtered by `definition` and `status`. |
| `DELETE /v1/admin/connections/{connectionId}` | Disconnect any connection. |
| `GET`, `POST`, `PATCH`, `DELETE /v1/admin/sites` | Manage trusted sites; `PATCH` sets `enabled` and `DELETE` takes `id`. |
| `GET`, `POST`, `DELETE /v1/admin/operators` | Manage operators; `DELETE` takes `id`. |
| `GET /v1/admin/apps` | App registry. |
| `POST /v1/admin/identities/{deploymentId:siteId:userId}/revoke-sessions` | End every session for an identity. |
| `GET /v1/admin/jobs` and `POST /v1/admin/jobs/{id}/cancel` | Every Job. |
| `GET /v1/admin/audit` | Audit log, paged with limit and before, filtered by action and definition. |
| `GET /v1/admin/catalog` | Repository data templates for independent definitions. |
| `GET /v1/admin/session` | Safe operator display, expiry and session-bound CSRF token. |
| `POST /v1/admin/session/logout` | Revoke the operator session and expire its cookie. |
| `GET /v1/admin/status` | Safe process/dependency/state observations. |
| `GET /v1/admin/metrics` | Bounded minute aggregates filtered by from, to and definition. |

## Console

| Method and path | Auth | Owner | Purpose |
| --- | --- | --- | --- |
| `GET /console` | Operator session or sign-in landing | HTTP surface | Optional same-server operator console. |
| `GET /console/assets/index.js` and `GET /console/assets/index.css` | None | HTTP surface | Fixed locally bundled assets, only when the console is enabled. |
| `GET /operator-sign-in?mode=console` | Sign-in cookie and operator grant | Identity | Existing Tableau/consent flow with a fixed console return. |

## Operator write and response rules

Create/PATCH/PUT accept write-only secrets and shared credential fields through the connections owner.
PATCH, PUT, retire and dedicated secret writes require expectedVersion; a stale safe version returns 409 definition-conflict.
Secret-management routes reject query input and never echo submitted fields.
Definitions use the definitions/definition wrappers and safe metadata in [contracts](contracts.md).
Redefinition additionally returns generation and connectionsEnded; retirement returns connectionsEnded.
Catalog returns templates, audit returns entries, and status/metrics use the exact [observation contracts](metrics.md).

## Health

| Method and path | Purpose |
| --- | --- |
| `GET /health/live` | Process is up. |
| `GET /health/ready` | The database answers, the schema is current and, with events on, the event bus is connected. |

The worker role serves the same two routes on `WORKER_HEALTH_PORT`, where readiness checks the database and that maintenance ran recently; other methods answer 405.
