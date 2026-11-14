# Events and client boundary

Status: proposed module contract.
Events owns verified ingress and replay; HTTP owns transport validation; the SDK owns client coordination without inventing authority.

## Event ingress

Each configured ingress route selects one provider registration and a provider verifier.
The route identifier is not authentication.
The HTTP adapter preserves bounded raw bytes and relevant headers for signature verification before parsing untrusted JSON.
The verifier checks the provider's actual signature/challenge scheme, timestamp/replay requirements and configured secret or public key.
Unsigned notifications are unsupported unless a separately reviewed authenticated transport proves their source.
Subscription challenges are distinct from accepted events and must follow the provider's verified challenge protocol.

The provider normalizer returns a stable event identity, typed safe event data and a routing key backed by verified payload evidence.
The events owner maps that key through stored subscription/connection associations; a payload cannot simply nominate an arbitrary app or holder.
The event deduplication key includes provider registration, source/subscription identity and provider event identity.
If the provider has no stable event ID, the adapter must declare a deterministic bounded replay key and its collision/retention limitations, or declare reliable deduplication unsupported.

Deduplication admission, audience routing and feed insertion commit atomically before success is acknowledged to the provider.
Duplicate delivery acknowledges the existing accepted event without adding another feed item.
Storage failure returns the provider's retryable failure response and never acknowledges an event as stored.
Normalization is bounded inline work; no raw-event processing queue is required for the initial contract.
Provider events do not automatically invoke capabilities.

## Feed and resynchronization

```ts
type ClientEvent = {
  id: string;
  type: string;
  version: number;
  occurredAt?: string;
  data: unknown;
};

type EventPage = {
  events: readonly ClientEvent[];
  nextCursor: string;
  hasMore: boolean;
};
```

Use authenticated polling of a durable per-app feed first.
Every row carries an audience of either the app's explicit service-policy audience or an exact delegated holder/connection association.
Reads apply current capability, connection and holder policy, including after disconnect.
A provider message concerning a delegated connection is never broadcast to every viewer of the app.
Only schema-approved minimum data is stored and returned; an invalidation hint is preferred when full provider payloads would disclose unnecessary information.

Feed order represents service acceptance order, not authoritative provider occurrence order.
A per-app counter is advanced under a row lock in the same transaction as insertion, with the lock held until commit.
This avoids acknowledging a high-water cursor past an earlier uncommitted row.
When one source event targets several apps, acquire app-counter locks in a deterministic order.
Notification mechanisms may wake readers later, but persisted rows and cursors remain authoritative.

Cursors bind app, holder/binding audience and expiry and are integrity protected.
Pagination advances over a bounded scanned range, including invisible rows, without exposing them.
The service returns `hasMore` when that scan limit prevents reaching the current head.
The client retains the last acknowledged cursor and may receive duplicates after interruption; it deduplicates by event ID.
No single-delivery or exactly-once browser guarantee is made.

When replay state expired, return `resync-required` instead of an apparently complete empty feed.
To start or recover, the client obtains a fresh feed cursor first, rereads authoritative state through read capabilities, then polls from that cursor and rereads state affected by subsequent invalidations.
The cursor-before-read order avoids losing notifications during the reread.
This is eventual resynchronization, not an atomic provider snapshot; a capability requiring stronger consistency must declare a provider-supported snapshot protocol.
Missed upstream notifications cannot be reconstructed by the feed alone, so relevant capabilities must permit authoritative rereads.

## HTTP surface

All routes below use a versioned `/v1` prefix and verified access except protocol callbacks and separately verified provider event ingress.
The path's resource ID never substitutes for authorization.

| Route | Contract |
| --- | --- |
| `GET /capabilities` | Current permitted definitions and connection availability. |
| `POST /invocations` | Validate and invoke a command; returns its typed result. |
| `GET /invocations/:id` | Inspect a currently visible receipt/result. |
| `GET /invocations/by-key/:key` | Recover an accepted command after its response and invocation ID were lost. |
| `GET /connections` | List only visible safe connection references and states. |
| `POST /authorizations` | Begin a permitted delegated flow. |
| `GET /authorizations/:id` | Read its state under the initiating holder association. |
| `DELETE /connections/:id` | Local disconnect plus honest remote-revocation status. |
| `GET /events/head` | Obtain a fresh authorized cursor for initial read or resync. |
| `GET /events?cursor=...&limit=...` | Read a bounded replay page. |

Static routes such as `by-key` are distinguished from invocation IDs by route registration and ID grammar.
Request keys in paths and query strings must be redacted from access logs.
Protocol callback and event URLs belong to configured adapters and do not expose a general provider credential API.
No public endpoint accepts arbitrary provider URLs, raw service credentials or operator app-registration commands.

Use 200 for completed inspection/execution, 202 for an already running receipt, 400 for invalid input, 401 for absent/expired binding, 403 for insufficient visible authority, 404 for non-visible resources, 409 for command conflicts or uncertain writes, 410 for expired retained state, 429 for capacity/rate limits, and 502/503 for provider/service unavailability.
The typed result and effect evidence remain authoritative; HTTP status alone never directs a write retry.
Responses carrying private state use no-store caching and safe correlation IDs.
Strict body/header limits and schema validation precede domain calls.
Cookie-based access requires explicit CSRF defenses in the selected access adapter; bearer-based access has its own replay and storage requirements.
Exact configured CORS origins constrain browser access but are not used as authentication.

## Browser SDK

The SDK accepts the service base URL and a caller-supplied access transport that obtains the chosen trusted binding.
It provides discover, invoke, inspect, connection status, explicit connect/disconnect, and event polling methods with shared exported types.
It keeps invocation request keys stable for response recovery and does not silently retry writes with new keys.
It never downgrades identity, selects a service connection for a delegated capability, or sends provider credentials from browser storage.

Connection initiation is an explicit user action when the service reports a requirement.
The browser opens the bounded authorization flow, validates exact message origin, expected window and transaction correlation, and treats any completion message only as a prompt to read server status.
Popup closure and timeout are distinct from denial or success.
If popups are blocked, a configured top-level return flow may be used without removing the correlation requirement.
No account is assumed connected merely because a popup closed.

The SDK passes cancellation, bounds polling and respects server retry delays.
It surfaces uncertain writes, expired results and resync requirements as explicit application states.
Optional web components or Tableau wrappers can consume this SDK later.
The core assumes no access to Tableau's private cookies, no identity proof from Tableau display names, and no unverified browser/version compatibility.
