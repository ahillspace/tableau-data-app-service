# Flows

End-to-end sequences across components.
Each step names its owner; detail lives in the linked component document.

## First use of a Data App

1. Viewer clicks a button in the Data App; the SDK calls `POST /v1/app-sign-ins` (Identity).
2. SDK opens the popup at `/sign-in/{transactionId}` (Identity).
3. The popup has no sign-in cookie, so it redirects to Tableau; the viewer signs in (Identity, Tableau).
4. `/tableau/callback` verifies the identity and trusted site and sets the cookie (Identity).
5. The popup posts the completion code to the opener and closes (Identity).
6. SDK redeems the code with its proof; the response carries the bearer and sets the restore cookie (Identity).
7. App calls `service.definitions()` and shows what it chooses (Connections).

See [app sign-in](identity.md#app-sign-in).

## Return visit

1. On load, the SDK calls `POST /v1/session/restore` with credentials (Identity).
2. The restore cookie points to a valid sign-in session; the service runs verify app location and returns a bearer (Identity).
3. The viewer sees no prompt.

## Shared provider call

1. App calls `service.fetch("slack-bot", "/chat.postMessage", …)` (SDK).
2. `/v1/native/slack-bot/chat.postMessage` authenticates the bearer (Identity).
3. Checkout finds the shared connection, checks the site is in the audience, and refreshes if needed (Connections).
4. The router places the token, checks the destination at socket time and streams the request and response (Router).
5. SDK returns the native `Response` to the app.

## Personal OAuth connection

1. Viewer clicks connect; the SDK calls `POST /v1/definitions/slack-user/connect` and opens `/connect/{transactionId}` (Connections).
2. The page checks the sign-in cookie identity matches and redirects to Slack (Connections).
3. Slack redirects to `/v1/oauth/callback`; the service exchanges the code, checks the generation and seals the token (Connections).
4. The page tells the opener and closes; the app calls the provider as the viewer.

## Add a provider

1. Operator runs `tdas definitions create` with a definition file; the CLI calls `POST /v1/admin/definitions` (Connections).
2. The service validates every field, stores the definition and bumps the revision.
3. The CLI asks for a secret link and opens it; the operator enters the client secret on the service page (Connections).
4. Every replica sees the new revision on its next checkout and loads the definition.

## Redefine a provider

1. Operator changes an endpoint with `tdas definitions redefine`; the CLI calls `PUT /v1/admin/definitions/{id}`.
2. One transaction increments the generation, disconnects old connections, deletes their credentials and bumps the revision.
3. Apps calling the definition get `not-connected` and offer reconnect; the definition ID is unchanged.

## Long-running work

1. App calls `service.jobs.submit(handler, input, { key })`; the Job is committed before the response (Jobs).
2. A worker claims it, checks out the owner's connection and runs the handler (Jobs, Connections, Router).
3. The handler starts an external task and returns a wait; the Job releases its slot (Jobs).
4. The external system calls `/v1/jobs/callbacks/{id}`; the Job resumes and finishes (Jobs).
5. The viewer returns from any Data App and reads the result (Jobs).

## Live events

1. App opens `service.events.subscribe(["slack-bot"], …)` (Events).
2. Slack posts to `/v1/events/ingest/slack-bot`; the source verifies the signature and acknowledges (Events).
3. The receiving replica publishes to Redis; every replica delivers to matching streams (Events).

## Operator CLI sign-in

1. `tdas login` listens on a loopback port and opens `/operator-sign-in` with its loopback address and PKCE challenge (Identity).
2. The operator signs in with Tableau if needed and approves operator access (Identity).
3. The service redirects to the loopback address with a one-time code; the CLI redeems it with its verifier and stores the operator bearer in the host credential store.

## Operator recovery

1. On the service host, `tdas-admin operators add --site <content URL> --user <username>` writes an operator record and an audit entry (Identity).
2. That person signs in and the record binds to their IDs.
