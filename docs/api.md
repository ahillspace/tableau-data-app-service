# API

All routes are under the service's public origin.
JSON routes accept and return `application/json`, and errors use the [error shape](contracts.md#errors).
Authenticated routes take `Tableau-Service-Authorization: Bearer <token>`.
API routes answer CORS for any origin, allow every request header the app sends, and expose every response header.
Routes marked credentialed echo the request's `Origin`, including `null`, and allow credentials; every other API route is called without credentials.
Pages are top-level service windows and carry the sign-in cookie.

## App sign-in

| Method and path | Auth | Owner | Purpose |
| --- | --- | --- | --- |
| `POST /v1/app-sign-ins` | None | Identity | Start an app sign-in with app ID, attribution and proof hash. |
| `GET /sign-in/{transactionId}` | Cookie | Identity | Popup page: Tableau sign-in if needed, then posts the completion code to the opener. |
| `POST /v1/app-sign-ins/{transactionId}/redeem` | Credentialed | Identity | Redeem completion code and proof for a bearer; sets the restore cookie. |
| `POST /v1/session/restore` | Restore cookie | Identity | Restore an app session with no prompt. |
| `GET /v1/session` | Bearer | Identity | Current identity, app ID and expiry. |

## Tableau sign-in

| Method and path | Auth | Owner | Purpose |
| --- | --- | --- | --- |
| `GET /tableau/sign-in` | None | Identity | Start Tableau sign-in for a page flow; redirects to Tableau. |
| `GET /tableau/callback` | None | Identity | Tableau's redirect; sets the sign-in cookie. |

## Operator sign-in for the CLI

| Method and path | Auth | Owner | Purpose |
| --- | --- | --- | --- |
| `GET /operator-sign-in` | Cookie | Identity | Operator approval page, opened by the CLI with its loopback address and PKCE challenge or by the setup page as a popup. |
| `POST /v1/operator-sign-ins/token` | Code and verifier | Identity | Redeem the one-time code for an operator bearer. |

## Definitions and connections for apps

| Method and path | Auth | Owner | Purpose |
| --- | --- | --- | --- |
| `GET /v1/definitions` | Bearer | Connections | Definitions the identity's site may use, with ownership and the caller's connection status. |
| `POST /v1/definitions/{id}/connect` | Bearer | Connections | Start OAuth connect; returns a connect transaction ID. |
| `GET /connect/{transactionId}` | Cookie | Connections | Connect page; redirects to the provider. |
| `GET /v1/oauth/callback` | None | Connections | The one provider OAuth callback, keyed by `state`. |
| `PUT /v1/definitions/{id}/credential` | Bearer | Connections | Store a personal static credential. |
| `DELETE /v1/definitions/{id}/connection` | Bearer | Connections | Disconnect the caller's personal connection. |

## Native routing and capabilities

| Method and path | Auth | Owner | Purpose |
| --- | --- | --- | --- |
| `ANY /v1/native/{definitionId}/{path}` | Bearer | Router | Forward a native request. |
| `POST /v1/capabilities/{definitionId}/{name}` | Bearer | Router | Call a preset capability. |

## Jobs

| Method and path | Auth | Owner | Purpose |
| --- | --- | --- | --- |
| `POST /v1/jobs` | Bearer | Jobs | Submit with handler, definition ID, input and submission key. |
| `GET /v1/jobs` | Bearer | Jobs | List the caller's Jobs. |
| `GET /v1/jobs/{id}` | Bearer | Jobs | Read a Job. |
| `GET /v1/jobs/{id}/result` | Bearer | Jobs | Read a Job's result. |
| `POST /v1/jobs/{id}/cancel` | Bearer | Jobs | Cancel. |
| `POST /v1/jobs/callbacks/{id}` | Handler verifier | Jobs | External task callback. |

## Events

| Method and path | Auth | Owner | Purpose |
| --- | --- | --- | --- |
| `GET /v1/events/stream` | Bearer | Events | Server-sent event stream. |
| `POST /v1/events/ingest/{definitionId}` | Source verifier | Events | Provider event delivery. |

## Operator API

Every operator route needs an operator bearer.
These are the routes the CLI and the optional setup page call.

| Method and path | Purpose |
| --- | --- |
| `GET /v1/admin/definitions` | List definitions, including disabled and retired. |
| `POST /v1/admin/definitions` | Create a definition. |
| `PATCH /v1/admin/definitions/{id}` | Change in place; refuses fields that need a redefinition. |
| `PUT /v1/admin/definitions/{id}` | Redefine; returns the new generation and the number of connections ended. |
| `POST /v1/admin/definitions/{id}/retire` | Retire. |
| `POST /v1/admin/definitions/{id}/secret-links` | Create a one-time secret link for a named field. |
| `GET /secret/{linkId}` and `POST /secret/{linkId}` | Secret entry page. |
| `POST /v1/admin/definitions/{id}/connect` | Start OAuth connect for a shared definition. |
| `DELETE /v1/admin/connections/{connectionId}` | Disconnect any connection. |
| `GET /v1/admin/connections` | List connections. |
| `GET`, `POST`, `PATCH`, `DELETE /v1/admin/sites` | Manage trusted sites. |
| `GET`, `POST`, `DELETE /v1/admin/operators` | Manage operators. |
| `GET /v1/admin/apps` | App registry. |
| `POST /v1/admin/identities/{key}/revoke-sessions` | End every session for an identity. |
| `GET /v1/admin/jobs` and `POST /v1/admin/jobs/{id}/cancel` | Every Job. |
| `GET /v1/admin/audit` | Audit log. |

## Setup page

The optional setup page is a static web app that calls only the operator API and gets its operator bearer from the [operator sign-in page](identity.md#operators).
The operator deploys it wherever they deploy the service; the service never serves or deploys it.
Its design is outside this specification.

## Health

| Method and path | Purpose |
| --- | --- |
| `GET /health/live` | Process is up. |
| `GET /health/ready` | Dependencies are ready. |

The worker role serves the same two routes on its own port.
