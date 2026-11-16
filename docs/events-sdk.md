# Events and SDK

This document covers optional live provider events and the browser SDK.
Requirements come from [product](product.md); shared types are in [contracts](contracts.md).

## Events

Events are optional and off by default.
With events off, the service creates no Redis client and needs no Redis.

### Event sources

An event source is preset code that receives provider deliveries at `/v1/events/ingest/{definitionId}`, verifies them, and turns each into an event.
An event carries its definition ID, an event type, the provider account it concerns, the provider's payload, and a receive time.
An event on a definition reaches every stream subscribed to that definition whose identity's site is in the definition's audience.
The rule is the same for shared and personal definitions; the Data App decides what to do with each event.

### Fan-out

The receiving API replica publishes each event to Redis publish and subscribe.
Every API replica subscribes and delivers to its own streams.
Delivery is lossy: there is no replay and no stored backlog.

### Streams

A Data App opens a server-sent event stream at `/v1/events/stream` with its bearer, naming the definitions it wants.
The stream delivers events the identity may receive, plus `possible-loss` when a slow client fell behind, Redis reconnected, or the stream started.
A slow client's buffer is bounded; when it fills, the oldest events are dropped and the client gets `possible-loss`.

### Failure

A Redis failure stops event fan-out and streams report `possible-loss` until it recovers.
Nothing else in the service depends on Redis.

### Slack event source

The Slack preset's source verifies Slack's `X-Slack-Signature` with the definition's sealed signing secret and rejects deliveries more than five minutes old.
It answers Slack's URL verification challenge.
It acknowledges within Slack's three-second window before fan-out.
The provider account is the event's team, or its enterprise when no team is present.
The source works the same on bot and user definitions.

## Browser SDK

The SDK is a small ES module with no runtime dependencies, loaded by the Data App.
It holds the bearer in memory and never stores it.

```ts
const service = createService({ origin: "https://service.example", appId: "sales-notes" });

await service.restore();                      // on load; no prompt; false if sign-in is needed
await service.signIn();                       // first sign-in; call from a user gesture
const res = await service.fetch("slack-user", "/chat.postMessage", { method: "POST", body });
const defs = await service.definitions();      // ownership, connection status
await service.connect("slack-user");           // OAuth popup; user gesture
await service.setCredential("my-api", key);    // static personal credential
await service.disconnect("slack-user");
const job = await service.jobs.submit("handler", input, { key });
const stream = service.events.subscribe(["slack-bot"], onEvent);
```

- `fetch` returns the provider's native `Response`; the SDK does not parse, wrap or retry it.
- The SDK sends every service call with `redirect: "manual"`, so a provider redirect comes back to the app and the bearer never follows it; browsers expose such a response as an opaque redirect.
- Service errors are thrown as `ServiceError` with the stable code and an `upstream` field that says whether the provider may have received the request.
- When the bearer has expired, the SDK tries `restore` once; if that fails, calls throw `sign-in-required` and the app calls `signIn` from a user gesture.
- `restore` and `signIn` read the page's declared attribution (site content URL, workbook and view) from the page URL and referrer, and sends it with the app ID.

The SDK validates only what it needs to talk to the service.
Its minified size target is under 15 KB.
