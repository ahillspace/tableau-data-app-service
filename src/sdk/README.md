# Browser client

Bundle `src/sdk/index.ts` in the Data App package.
It exports `ServiceClient`, optional `JobsClient`/`EventsClient`, native request types and schema-derived public resource types.
It imports no server claim, secret, database or Redis implementation.

```ts
import { ServiceClient } from "./sdk/index.js";

const client = new ServiceClient({ serviceOrigin, appId, deploymentId });
await client.initialize(); // Existing-session restoration; the caller handles denial.
const discovery = await client.discover();
const connections = await client.connections({ provider: "slack" });
const response = await client.request({
  providerRegistrationId: "slack",
  endpoint: "api",
  connectionId: connections[0]!.id,
  method: "GET",
  path: "/auth.test",
});
// Reading the body is the application's deliberate choice.
const result = await response.json();
```

Call `signIn` or `connect` directly from a user gesture so the browser can preopen the correlated service window.
`signIn` accepts `{signal?}`; `connect` accepts the canonical authorization inputs without an initiation verifier, which the SDK generates in memory.
Both check popup origin, source window and transaction, handle close/abort/expiry, and read authoritative service completion.
Only session initiation/redemption/restoration uses credentialed fetch; ordinary traffic omits cookies and uses the client's memory bearer.
`session()` exposes identity and fixed expiries without the bearer.
Restoration cannot silently change an established client's owner or deployment.
Functional login remains enabled under the user-accepted deferral recorded in the run guide.
Initial cross-client silent-enrollment binding remains an explicit residual exposure; no browser storage or alternative login fallback is added.

`discover`, `connections`, `connection`, `setupStatic`, `disconnect`, `beginAuthorization`, `authorization` and `cancelAuthorization` use canonical public schemas.
Reconnect and disconnect require the connection's current expected authority generation.
`request` supports native string, Uint8Array, Blob and FormData bodies, including explicit empty GET/HEAD bodies through the carrier.
`invoke` requires a discovered HTTP entrypoint and its declared JSON or native input mode.
Both return a Response at headers, preserve native HTTP errors and redirects, and leave streaming/body consumption to the caller.
An AbortSignal or body cancellation stops local consumption; it does not promise rollback of provider effects.
Neither a failure nor authentication restoration retries a business request or converts it into a Job.

`client.jobs.submission({capability,input,connectionId?})` creates a key for a new logical command.
Pass that exact command to `client.jobs.submit(command,{signal?})` and retain it unchanged only for deliberate lost-admission recovery.
`jobs.list({appId?,state?,capability?,next?,limit?,signal?})` rediscovers retained current-owner work; pass its opaque continuation unchanged with the same filters.
Pages use service keyset order and are not a snapshot across concurrent changes.
`jobs.get`, `jobs.cancel` and `jobs.result` accept a Job ID and `{signal?}`.
`jobs.result` returns the direct HTTP Response, including explicit not-ready/absent/expired states; it never unwraps JSON or regenerates work.
The SDK does not schedule polling or retain commands globally.
Slack registers no named capabilities; a separate test provider exercises the generic Jobs API.

After discovery advertises `events`, call `client.subscribe(callback,{signal?,sourceId?,connectionId?,jobId?,reconnect?})`.
It uses discovery's exact configured payload budget with no additional request or private default.
The callback receives decoded native provider data, Job ID hints or `resync-required`.
Hints are notifications to reread current state, and resync means the application refreshes its own state; neither represents retained event history.
Optional reconnect resumes future notifications only, with one same-identity session restoration attempt on marked service 401.
Protocol errors, authority denial and callback failures stop reconnect.
Changing identity aborts existing subscriptions before another owner can be adopted.
No Last-Event-ID, automatic polling or business replay is sent.

Call `close()` when the page is disposed to abort local requests, windows and subscriptions.
It does not disconnect accounts, cancel durable Jobs or sign out a server session.
The small Slack example and actual browser/media verification are documented under `examples/slack` and [synthetic browser verification](../../docs/running.md#synthetic-browser-verification).
