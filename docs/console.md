# Operator console

The optional console runs on the same API server at /console and is disabled by default.
It owns presentation and form state; Identity owns authority, Connections owns credentials, and Operations owns observations.
It uses the same operator API as tdas with no private business API, local passwords or separate account database.

The shared API uses stable wrapper keys for the CLI and console.
Definition list returns `{definitions: DefinitionView[]}`; detail/create/PATCH/secrets return `{definition: DefinitionView}`.
PUT additionally returns `{generation,connectionsEnded}` and retirement returns `{connectionsEnded}`.
Existing safe errors remain `{error:{code,message,fields?:[{path,rule}],upstream?}}`.
Every field error names only a schema path and stable rule, never the rejected value.

`CONSOLE_ENABLED=false` by default; when disabled `/console` and its asset/login helpers are unavailable.
The console uses the existing operator sign-in, Tableau OIDC correlation and consent flow with a new fixed console destination, never an arbitrary return URL.
On approved consent, Identity issues the same operator session kind through a Secure, HttpOnly, host-only cookie named `__Host-tdas-operator`, with Path=/ and SameSite=Strict after login.
The existing temporary OIDC correlation cookie retains callback-compatible SameSite=Lax semantics for top-level GET callbacks.
Do not apply Strict prematurely to callback correlation or replace the existing CLI PKCE/code flow.
Cookie transport is accepted only for shared `/v1/admin/*` routes and never gives an app/native route authority.
Resolve operator status from the server directory on every request; removal, revoked sessions, untrusted sites and expiry revoke access immediately.
Reject ambiguous mixed cookie/bearer authentication instead of guessing the principal.
For cookie-authenticated reads require same-origin request context; permit no credentialed cross-origin admin CORS.
For every cookie mutation require an exact configured Origin and session-bound CSRF token in `X-TDAS-CSRF`, with JSON content type where a body exists.
Bearer-authenticated CLI requests keep their existing explicit credential transport and do not require a browser Origin or CSRF token.
Console JS never receives or stores a bearer, and no credential goes into localStorage/sessionStorage.
`GET /v1/admin/session` returns `{operator:{displayName:string},expiresAt:string,csrfToken:string}` with no-store.
`POST /v1/admin/session/logout` revokes the session and expires the cookie, requiring the same mutation checks.
A non-operator page explains that Tableau sign-in succeeded but operator access is absent, without returning protected data.
Bundle production assets locally, with CSP restricted to self, no inline script, no runtime CDN, no framing and no object/embed support.

## Presentation

Providers and Status & analytics are two separate top-level tabs, each with its own loading, empty, failure and retry states.
The Providers table is searchable and filterable by method, ownership and state, with name, method, ownership, hosts, generation and connection counts.
A keyboard-accessible side peek shows readable properties, secret set/setAt metadata and actions to edit, rotate, connect or retire.
Add from template and from scratch lead to the same structured definition form.
Explain redefinition consequences and the number of connections affected before submitting PUT.
Secret inputs start empty and are never hydrated from reads; blank fields are omitted, clearing is a separate explicit action, and inputs reset after success or dismissal.
The status view uses a service summary, compact process/state tables, a small request chart, histogram-derived percentile labels and a filterable audit table.
Use neutral typography, generous whitespace, compact database tables and subtle frosted navigation/dialogs, with opaque and reduced-motion fallbacks.
Prototype data is synthetic and clearly labeled; production assets never contain a fallback dataset.

## Session states and setup actions

The fixed sign-in entry is /operator-sign-in?mode=console.
Consent denial returns to /console?auth=denied and grants no operator authority.
The session endpoint returns 401 sign-in-required for missing, expired or revoked operator sessions.
A verified non-operator receives an operator-required page or 403 without protected data.
A plain sign-in cookie cannot be promoted through a session read.
The UI clears protected state on 401/403 and requires explicit resubmission after sign-in or a concurrent-edit conflict.
Shared authorization_code connect returns kind redirect with transactionId, url and expiresAt and keeps the existing tableau-service:connect completion message.
The UI checks message origin, source and transaction before reloading the safe connection state.
Blocked, closed and failed popups leave the current connection unchanged.
Shared client_credentials Connect returns kind connected with definitionId and connectionId after local authorization, opens no provider window and reloads the safe setup state.
Its setup view distinguishes missing application secrets from missing shared connection authorization; Connect remains a supported action while the server enforces prerequisites.
Application secrets are set through write-only input; later entry or rotation never establishes or renews machine authorization.
After staging secrets, disconnecting or reaching the reauthorization interval, the operator explicitly connects again, and token exchange remains lazy at checkout.

## Assets and accessibility

The authored HTML loads /console/assets/index.js and /console/assets/index.css from the same origin.
Plain TypeScript and the existing esbuild bundle the UI; it has no runtime package, CDN, chart or icon dependency.
Tabs support keyboard navigation, table rows expose real buttons, and dialogs trap focus, close with Escape and restore focus to the opener.
Field errors identify controls and receive focus on failed submission.
Tables scroll inside their container at narrow widths rather than wrapping columns into unreadable text.
Common protocol fields have structured controls, while advanced JSON edits the same backend-owned data schema and shows its field errors.

## Failure and extension

Unavailable responses offer retry without inventing healthy data.
Secret controls clear after submission or dismissal and never rehydrate on a failed request.
Concurrent edits preserve public draft values but require a fresh safe version and explicit review before resubmission.
Add console presentation through shared API views and browser-safe type-only imports, without an alternate authorization or validation engine.
Implementation and live acceptance remain separate from prototype feedback.
