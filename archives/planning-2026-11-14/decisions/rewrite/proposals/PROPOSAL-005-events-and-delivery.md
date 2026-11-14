# PROPOSAL-005: Bounded replay, SSE, and signed backend webhooks

Status: new architecture recommendation for user review, completing the delivery choices left open by REWRITE-011.
Recorded: 2026-11-08.

## Recommendation and why

Use one durable accepted-event store in Postgres, with audience-specific delivery references for browser replay and backend webhook attempts.
Preserve the provider's usable payload inside a small envelope containing event ID, provider/type, safe connection reference, acceptance time, and provider occurrence time when supplied.
Do not require a universal provider schema or a managed read capability before an event integration is allowed.
Shared storage makes reconnect and backend retries possible without a broker; finite retention keeps it an integration service rather than an event archive.

Recommend seven-day accepted-event replay and deduplication retention and a twenty-four-hour webhook attempt window as explicit initial defaults.
These values were not accepted earlier and remain proposals here.
Extend provider deduplication retention where its documented redelivery horizon requires it, or declare that later duplicates can be admitted as new events.
Consumers should not treat seven-day local deduplication as complete upstream deduplication.
Bound event payload size, subscriber count, per-app retained bytes, and ingress rate; when storage limits prevent durable admission, fail ingress honestly instead of acknowledging and dropping an event.

## Ingress and authority

Verify bounded raw request bytes, signature/challenge rules, and the configured provider source before parsing and accepting events.
Map the verified subscription/installation/source to the approved connection and audience through server-owned associations.
Payload app IDs, user IDs, or connection references never grant routing authority.
Deduplicate stable provider event IDs scoped to that source; an adapter without reliable IDs must supply a valid bounded deterministic deduplication key and document its limitations.
If neither is possible, event ingress is unsupported until the incoming-event deduplication requirement is explicitly reconsidered.

Preserve fields needed by the authorized consumer, removing known secrets through a provider-specific policy.
If a payload cannot be safely exposed, deliver a safe notification/reference or declare that event type unsupported.
Do not equate native payload preservation with permission to forward provider secrets.
Store accepted event identity, allowed audience references, and any initial backend delivery rows in one commit before acknowledging the provider.
Neither ingress nor delivery implicitly invokes capabilities or starts jobs.

Delegated events remain scoped to their owner and explicitly authorized backend grants.
App-wide events require an intentional service/source audience.
Recheck current subscriptions, app policy, owner, connection epoch, and backend grants before disclosure or each webhook attempt.
Removing a subscription or disconnecting a connection suppresses pending delivery; it does not retract bytes already delivered.

## Browser replay and ordering

SSE is the normal browser delivery transport.
Use authenticated fetch with the SDK's memory bearer header and a maintained SSE parser, rather than assuming native EventSource supports arbitrary authorization headers.
The standard EventSource constructor exposes URL and credentials configuration, and the parser candidate accepts streaming input: [HTML SSE standard](https://html.spec.whatwg.org/multipage/server-sent-events.html), [eventsource-parser project](https://github.com/rexxars/eventsource-parser).
Do not put access tokens in stream URLs or silently fall back to browser polling.

Use a per-app sequence allocated under a transaction-held counter-row lock so a later committed cursor cannot skip an earlier uncommitted event.
Acquire multiple app locks in a stable order when routing one source event to several apps.
This order describes local acceptance, not provider occurrence or causality.
Use an opaque encoded cursor containing replay namespace, position, and the current subscription-view revision.
Validate its syntax, bounds, and revision, while deriving app/audience and all authority from the current authenticated request.
Do not sign or encrypt this cursor: changing a position can only alter which already-authorized retained events the caller asks to replay, not grant access.
Scanning invisible rows advances position without exposing them, using bounded batches.

The SDK retains the last application-processed cursor in its memory stream handle.
Reconnect requests replay after that position and can receive duplicates; consumers deduplicate by the stable event ID.
Sequential application delivery means an asynchronous handler must finish before the SDK advances that cursor.
A page reload without a retained cursor starts with resynchronization; no durable client acknowledgement protocol is promised.
Include heartbeat comments, bounded reconnect backoff with jitter, explicit session-expired handling, and a connection lifetime no longer than the session's remaining lifetime.
On session expiry, close the stream and resume only after successful identity establishment; idle tabs may need user interaction under PROPOSAL-002.

If retained history is unavailable, the cursor namespace/revision changed, or the requested position is outside the retained range, return `resync-required` before opening the stream or as a control event on an already open stream.
Start/resync obtains a current cursor first, then the app rereads its authoritative provider state through native proxy calls or a capability, then consumes events after that cursor.
This prevents a local read/subscribe gap but does not create an atomic provider snapshot or reconstruct missed upstream events.
An event integration must document its resync route or explicitly state that lost events cannot be reconstructed; irreversible notification-only streams cannot promise complete recovery.

## Multiple API processes and backpressure

Each API process owns its open browser streams and has a dedicated Postgres listener connection.
Use `LISTEN/NOTIFY` only as a wakeup that prompts authorized reads from durable rows; send no event payload or credentials through notifications.
Commit listener registration before scanning durable state, and rescan after listener reconnection so the documented startup race cannot skip existing data: [Postgres LISTEN](https://www.postgresql.org/docs/current/sql-listen.html).

Prefer a best-effort notification after the event commit, so notification failure does not reverse durable acceptance.
A bounded server-side sweep of active streams catches lost wakeups; this is internal fanout maintenance, not browser polling.
The official notification contract is transactional and intended to signal readers to inspect tables: [Postgres NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html).
No sticky load-balancer session is needed for replay correctness.

Bound each stream's buffered bytes and pending events.
Close a slow consumer with a reconnect/resync indication where possible instead of growing memory without limit or blocking other subscribers.
A database failure closes streams and prevents further durable acceptance.
Current authority must be checked before each event delivery or authorized bounded batch; idle heartbeat checks also close expired/revoked sessions.

## Backend webhook delivery

Configure destinations and allowed audiences through the backend grants in PROPOSAL-006.
Sign exact transmitted bytes using the Standard Webhooks format and its maintained TypeScript library, including event/delivery identity and timestamp: [specification and libraries](https://github.com/standard-webhooks/standard-webhooks).
Use a separate signing secret per destination; possession verifies sender origin but grants no inbound API access.
Receivers verify timestamp/signature, deduplicate the stable delivery ID, and durably record the event before returning success.

One delivery row per event/subscription tracks next attempt, count, claim, acknowledgement, and expiry.
Use the common worker's short claims, but webhook retries are transport delivery attempts and do not inherit capability retries-off policy.
Recommend an immediate attempt and exponential backoff with jitter, starting around thirty seconds and capped at one hour, with at most twenty attempts and no attempt after the twenty-four-hour window.
Respect a valid Retry-After within that remaining window.
Treat 2xx as acknowledgement, network failures/408/429/5xx as retryable, and other non-2xx responses as terminal delivery failures requiring correction.
Do not follow redirects.
Report disabled/failed subscriptions and exhausted deliveries in operator status; a 410 may disable the destination until explicitly repaired.

A lost receiver acknowledgement can produce a duplicate delivery.
Do not promise exactly once or strict webhook ordering; a retried older event may arrive after a newer one.
Include the service acceptance sequence and provider ordering/version evidence when available so a receiver can reconcile.
Replay after failure is an explicit authorized operation while the event remains retained, using the same delivery identity and current audience policy.
After retention expiry, report unavailable history; do not synthesize a successful replay.

## Costs, specification implications, and completion evidence

A transient-only stream is smaller but cannot support the accepted reconnect and backend outage scenarios reliably.
Strict global ordering and indefinite replay would add head-of-line blocking, storage, and recovery obligations without an accepted requirement.
The recommendation offers bounded replay and delivery attempts while making upstream completeness, duplicates, and out-of-order webhooks explicit.

Replace baseline browser polling, universal normalized event schemas, and mandatory resync capabilities in contracts/events/persistence/SDK.
Keep verified ingress, source associations, current audience authorization, and commit-before-acknowledgement.
Exercise provider duplicates, invalid signatures, payload secret removal, a delayed event transaction, two API processes, lost notification/listener reconnect, a slow browser, session expiry, webhook response loss, subscription revocation, and expired/restore-reset cursors.
Live Tableau frame/network streaming, hosting buffering/timeouts, provider ingress guarantees, and receiver signature interoperability require separate integration evidence.
