# Events and SDK

This document covers optional live provider events and the browser SDK.
Shared types are in [contracts](contracts.md).

## Events

Events are optional and off by default.
Setting `REDIS_URL` turns them on.
With events off, the service creates no Redis client and needs no Redis, and the event routes answer `events-off` with status 404.

### Event sources

A definition selects [typed verification, handshake and extraction data](provider-protocol.md#inbound-verification) for deliveries at POST /v1/events/ingest/{definitionId}.
The shared Events owner interprets that data and never runs an operator-authored script.
A source that needs one verifies deliveries with the definition's sealed signing secret, and a delivery that fails verification is refused before anything is published.
The ingest route reads the body as raw bytes, because provider signatures cover the exact bytes.
An event carries an ID, its definition ID, an event type, the provider account it concerns, the provider's payload, and a receive time.
An event on a definition reaches every stream subscribed to that definition whose identity's site is in the definition's audience.
The rule is the same for shared and personal definitions; the Data App decides what to do with each event.

### Verification boundaries

Slack uses timestamped raw-body HMAC; GitHub uses raw-body HMAC without an invented timestamp requirement.
Stripe supports compound timestamp headers and multiple candidate signatures.
Graph basic notifications compare each clientState in constant time and remove verification material before fan-out.
The Graph validationToken handshake returns URL-decoded plain text and emits no business event.
Rich encrypted Graph notifications and automatic subscription lifecycle are not implemented.
A missing webhook signing secret refuses ingress but never blocks normal native checkout.
Verification uses original request bytes, bounded selectors and constant-time comparisons.
Handshake requests never enter fan-out or business-event duplicate suppression.

### Fan-out

The receiving API replica answers the provider first, then publishes each event to Redis publish and subscribe.
Every API replica subscribes and delivers to its own streams.
Delivery is lossy: there is no replay and no stored backlog.

### Streams

A Data App opens a server-sent event stream at `GET /v1/events/stream?definitions=a,b` with its app bearer, naming up to 50 definitions.
Each definition must exist, be enabled, include the caller's site in its audience and have an event source; otherwise the stream is refused with an ordinary JSON error before it starts.

The stream sends these frames:

| Frame | Meaning |
| --- | --- |
| `event` | One event the identity may receive. |
| `possible-loss` | Events may have been missed, with a reason: `stream-start`, `slow-client`, `fan-out-reconnected` or `fan-out-unavailable`. |
| `end` | The service closed the stream for good, with a reason: `session-expired`, `session-ended` or `service-stopping`. |

Every stream starts with `possible-loss` because nothing before it is replayed.
A comment heartbeat is sent every 25 seconds.
Each stream buffers up to 256 frames for a slow client; when the buffer fills, the oldest events are dropped and the client gets `possible-loss`.
Every 30 seconds the service rechecks each stream's session and ends streams whose session expired or was revoked.

### Failure

A Redis failure stops event fan-out, and streams report `possible-loss` with `fan-out-unavailable`, then `fan-out-reconnected` when it recovers.
API readiness reports the event bus, so a replica without Redis reads as not ready while events are on.
Native requests, Jobs, sign-in and the operator API do not depend on Redis.

## Browser SDK

The SDK is one ES module with no runtime dependencies, built to `dist/sdk/index.js` and loaded by the Data App.
It holds the bearer in memory and never stores it.
The build fails if the minified module reaches 15 KiB.

```ts
const service = createService({ origin: "https://service.example", appId: "sales-notes" });

await service.restore();                      // on load; no prompt; false if sign-in is needed
await service.signIn();                       // first sign-in; call from a user gesture
const res = await service.fetch("crm", "/v2/contacts", { method: "POST", body });
const defs = await service.definitions();     // ownership, setup options, connection status
await service.connect("crm");                 // OAuth popup; user gesture
await service.setCredential("my-api", { kind: "token", value: key }); // owner-bound input
await service.disconnect("crm");
const job = await service.jobs.submit("handler", input, { definition: "my-api", key });
const sub = service.events.subscribe(["chat"], onEvent, { onLoss, onEnd });
```

### Surface

| Member | Does |
| --- | --- |
| `createService({ origin, appId, attribution?, fetch?, window? })` | Creates the client; `attribution` overrides what is read from the page. |
| `restore()` | Restores a session from the restore cookie with no prompt; resolves `false` when a sign-in is needed. |
| `signIn()` | Runs the first sign-in in a popup; call from a user gesture. |
| `session`, `signedIn` | The current session and whether one is held. |
| `attribution()` | The site content URL, workbook and view the SDK declares. |
| `signOut()` | Discards the bearer in this page; nothing ends on the server. |
| `fetch(definitionId, path, init)` | A native request; `path` starts with `/`. |
| `capability(definitionId, name, input)` | Calls a named operation attached to the definition. |
| `definitions()`, `definition(id)` | Definitions the viewer's site may use, with ownership, setup options, connection status and account. |
| `connect(definitionId)` | Runs the OAuth connect popup for a personal definition; call from a user gesture. |
| `setCredential(definitionId, credential)` | Stores a typed personal static/JWT credential or catalog JSON import. |
| `disconnect(definitionId)` | Disconnects the viewer's own connection. |
| `jobs.submit(handler, input, { definition, key? })` | Admits a Job; a random UUID key is used when `key` is omitted. |
| `jobs.get`, `jobs.list`, `jobs.result`, `jobs.cancel`, `jobs.wait` | Reads, lists, fetches the result of, cancels, or polls a Job until it finishes. |
| `events.subscribe(definitionIds, onEvent, { onLoss, onEnd })` | Opens a stream that reconnects with a backoff of 1 to 30 seconds and returns `{ close }`. |
| `readAttribution(...urls)` | Reads site, workbook and view from Tableau URLs. |

### Behavior

- `fetch` returns the provider's native `Response`; the SDK does not parse, wrap or retry it.
- Calls that carry the bearer use `redirect: "manual"`, so a redirect comes back to the app and the bearer never follows it; browsers expose such a response as an opaque redirect.
- Service errors are thrown as `ServiceError` with the stable code, the status, any field errors and an `upstream` field that says whether the provider may have received the request.
  On native and capability routes the service marks its own errors with `Tableau-Service-Error: 1`, and the router removes that header from provider responses, so a provider response is never taken for a service error.
- When the service rejects an expired bearer with `sign-in-required`, which it does before any provider is called, the SDK tries `restore` once and resends, unless the body is a stream that cannot be sent twice; if that fails, calls throw `sign-in-required` and the app calls `signIn` from a user gesture.
  A provider's own 401 is returned to the app and never resent.
- `restore` and `signIn` read the page's attribution (site content URL, workbook and view) from the page URL and referrer, and send it with the app ID.
- SDK errors of its own are `popup-blocked`, `popup-closed`, `connect-incomplete`, `invalid-path` and `invalid-options`.

The SDK validates only what it needs to talk to the service.

### Discover an installation

From the service URL, fetch `/v1/discovery` for the built browser SDK, its types, a working example and Tableau sign-in guidance.
After app sign-in, `service.request("/v1/discovery")` returns the viewer's current service actions, provider definitions, connection readiness and attached operation contracts.
Use the returned definition ID, qualified operation name and input contract to call `service.capability(definitionId, name, input)`.
