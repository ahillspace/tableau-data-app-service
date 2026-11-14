# Events, HTTP, and SDK

Status: integrated optional Redis/live-delivery and browser wire contracts; implementation and platform verification remain future work.
Events owns source verification/routing and transient distribution; HTTP owns wire validation and SDK owns the thin browser adapter.
[Access](access-connections.md) owns identity/audiences, and [Jobs](providers-execution.md) owns durable callback transitions independently of live notifications.

## Optional event ingress

Enable events explicitly per deployment; disabled mode constructs no Redis client or connection and requires no broker for startup/readiness.
A provider declares source identity, signature/challenge/replay verification, native payload interpretation and manual, Data App or service setup ownership.
Preserve bounded exact raw bytes/headers where verification requires them; reject unsupported verification rather than accept unsigned payloads by default.
Payload app/owner/source locators are untrusted until mapped through verified source evidence and current stored associations.
Personal events follow owner equality in verified deployment/site scope; shared sources use explicit current verified-site/user audiences.
App IDs can filter attribution but never authorize another owner or broaden an audience.

Verify and route once, then publish a bounded native notification without waiting for every browser recipient.
Acknowledgement means verified best-effort forwarding acceptance, never browser receipt, durable storage or replay.
If forwarding is unavailable, return the provider-documented failure response; a healthy publish with zero subscribers is an acknowledged drop.
An ambiguous publish is recorded as possible loss/duplication and is not automatically repeated by the service; provider redelivery remains possible under its protocol.
Slow/disconnected subscribers are handled independently and do not hold a provider acknowledgement open.
No generic dedupe state machine is mandatory; an integration may add a bounded source-scoped cache where stable IDs make it useful.
Dedupe is neither signature replay protection nor exactly-once delivery, and eviction/restart can admit duplicates.
Provider events do not launch business Jobs automatically.
Useful native payload is ordinary event data; a hint-only integration must justify its extra fetch and loss of transient details.
Job-ID completion hints specifically refer to saved Job state/results and do not define all capability or provider event payloads.

## Redis transport and live SSE

Redis Pub/Sub completely replaces temporary database event relay/fetch/delete machinery and any Postgres notification transport.
No raw-event table, outbox, replay archive, Redis Stream or durable delivery queue exists.
Postgres stores authoritative source associations, audiences and Jobs; Redis stores no durable authority or coordination lock.
Each API replica has a dedicated subscriber connection plus bounded publishing access where needed; the worker publishes optional postcommit job-ID hints only when events are enabled.
Every API subscribes before event readiness, including reconnect acknowledgement, and all messages use that receive path, even when published locally.
Use deployment-scoped channel prefixes and exact subscriptions so one event is not also duplicated through overlapping pattern subscriptions.
Redis logical database numbers do not isolate Pub/Sub channels, and disconnected subscribers cannot recover missed messages from Pub/Sub ([Redis delivery and scoping](https://redis.io/docs/latest/develop/pubsub/)).
Channels/audience fields are routing hints only, never authorization.

A durable job transition commits first, then optionally publishes an opaque job ID/revision hint without result/input bodies.
A subscriber rereads current Jobs state under disclosure authority before forming a browser notification.
Hint failure cannot roll back a result, delay durable callback acknowledgement or prevent bounded work scans.
Authentication, proxy, job admission/recovery and task callbacks continue during Redis failure when their own dependencies are healthy.
Core API readiness must not remove every replica because event readiness is degraded.
Expose event status separately, fail new event streams/forwarding honestly while unavailable and keep the underlying durable APIs usable.

### One payload and age contract

Events owns one configured logical native payload cap `P` in bytes, enforced on accepted verified ingress and preserved through all forwarding stages.
For JSON, count the exact UTF-8 serialization of the native data; for a provider-defined raw payload, count its verified raw bytes and declare its media type.
A raw ingress representation limit may account for signatures/wrappers, but it cannot accept a logical payload that fails only because a smaller downstream logical allowance was invented.
Bound envelope fields independently and compute transport budgets from `P` and the chosen encoding, including JSON escaping, SSE framing and physical client buffers.
Use versioned base64url bytes in the internal Redis envelope to avoid unbounded secondary JSON escaping; `N` bytes require `ceil(4*N/3)` unpadded encoded characters.
The public SSE wire uses the same bounded payload representation plus metadata, and the SDK decodes the native payload once for its callback API.
Ensure a maximum accepted event fits one supported per-stream message budget or reject incompatible configuration before event readiness.
Do not truncate native payloads or shrink their allowance through envelope overhead.

```ts
type LiveEnvelope = {
  version: 1;
  kind: "provider" | "job-hint";
  eventId: string;
  sourceId?: string;
  sourceRevision?: number;
  jobId?: string;
  jobRevision?: number;
  ingressAt: string;
  expiresAt: string;
  payloadEncoding?: "base64url";
  payloadMediaType?: string;
  payload?: string;
};
```

The public SSE `event` field is `provider`, `job-hint` or `resync-required`, with one bounded JSON `data` value:

```ts
type PublicLiveData =
  | { version: 1; kind: "provider"; id: string; provider: string;
      connectionId?: string; type: string; payloadEncoding: "base64url";
      payloadMediaType: string; payload: string }
  | { version: 1; kind: "job-hint"; id: string; jobId: string; revision: number }
  | { version: 1; kind: "resync-required"; reason: "connected" | "possible-loss" };
```

The event name and discriminant must agree; metadata uses the same bounded schemas and computed framing budget, with no private source verifier/account context.
The SDK decodes provider JSON to native `data` or declared raw data to `Uint8Array`, yielding the [public notification](contracts.md#live-notifications-and-service-errors); it never wraps native proxy responses in this envelope.
Job hints disclose only authorized identity/revision; the app retrieves JobView/results from authoritative APIs.
SSE IDs are opaque notification identities, never replay cursors.

Provider envelopes require source ID/revision and payload; job hints require only job ID/revision and no result body.
IDs, media types and all envelope fields have bounded shared schemas; reject unknown versions, invalid combinations and oversized encoded data before allocation/decoding.
Trusted ingress timestamps are assigned by the service, never copied from provider payload timestamps as authority.
Configure a maximum event age and measured clock-skew tolerance across replicas; validate expiry ordering and reject implausible future ingress time.
Check age on subscriber receipt and again before logical delivery; socket/broker buffering is not an event TTL.
Expired/obsolete queued events are discarded, with safe loss counters.

### Current delivery and backpressure

On receipt, check source active state/revision and current personal/shared routing before enqueue to each local stream.
Immediately before beginning each logical SSE event, recheck current session, fixed authentication expiry, enabled verified site and personal/shared audience plus source revision or job disclosure.
Use current authoritative Postgres reads, batching immediately deliverable recipients without waiting for slow clients.
Enqueue and logical delivery may share that read only with no intervening wait/async boundary; queued delivery needs a fresh check.
A cache invalidated only by lossy Redis messages cannot authorize stale delivery.
Keep no authority locks through network writes; bytes released by a completed check cannot be recalled by a later revocation.
Private event data is never broadcast merely because the browser named a connection/source ID.

Bound publisher pending bytes, subscriber decode/work queues, Redis client output/input buffers, per-SSE queued bytes and aggregate API memory separately.
Do not await a slow browser in the shared subscriber callback, allocate a full maximum buffer for every idle stream or create unbounded async tasks per recipient.
Drop/close slow clients under measured queue/stall limits, clear their buffers and signal resync where the transport permits.
Disable offline publish queues or bound them to immediate failure without retention, and disable automatic retry of ambiguous publishes.
Reconnect resubscribes for future events, clears obsolete local queues and signals possible loss to affected browsers; never replay cached pre-outage payloads as fresh.
Broker output-buffer disconnection is an event loss boundary ([Redis client buffers](https://redis.io/docs/latest/develop/reference/clients/)).

Use private broker access, verified TLS, separate publish/subscribe credentials with deployment-channel ACLs and least-privilege commands.
Treat Redis as a trusted transient plaintext boundary for private event data; exclude entrusted secrets and body logging, and configure observability without payload capture ([Redis TLS](https://redis.io/docs/latest/operate/oss_and_stack/management/security/encryption/), [Redis ACLs](https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/)).
No broker persistence is used to promise event retention.

Browser SSE uses authenticated fetch with the current service bearer and AbortSignal; native EventSource cannot supply the chosen arbitrary authorization header.
Each connection/reconnection sends `resync-required`, with no Last-Event-ID replay contract.
The app fetches current provider state where supported and reads retained Jobs after lost hints; some events cannot be reconstructed.
Configure SSE-only comment heartbeats, stall limits and jittered reconnect delays from actual ingress/browser evidence.
On service 401, the common session manager may restore/renew still-valid authority once before reconnect; true expiry/denial stops reconnect pending explicit identity recovery.
A native provider 401 is not a service-session failure.
SSE reconnect never repeats proxy requests or job submissions and never silently switches to normal browser polling.

## Proposed HTTP surface

The [API inventory](../planning/api-design.md#endpoint-inventory) maps routes to these canonical contracts; names remain draft compatibility choices.
Private routes require current verified service authority, configured app context and resource ownership/shared audience, not personal app-use grants.
Callbacks, registry administration and provider ingress use separate transaction/source/management authority.
Use POST for setup/launch/import/disconnect, ordinary capability invocation and explicit Job submit/cancel; GET status/result never performs provider work.
A39 uses current request authority with declared JSON or native body input and returns declared JSON or native HTTP with the same response carrier/error/stream rules, without Job acceptance, progress or persistence.
New admission returns 202 plus Location and JobView; equal authorized recovery returns 200, changed command 409.
Private resource responses use no-store; errors use the [shared vocabulary](contracts.md#live-notifications-and-service-errors).

The bearer and app path never reach the provider.
Carry connection selection in `X-Integration-Connection` and native header pairs as base64url UTF-8 JSON in `X-Integration-Request-Headers`.
Validate once with a shared codec, then enforce Transport's credential-owned fields before injection.
Raw body/query stays native rather than a universal JSON/base64 body wrapper.
Reject request hop-by-hop fields, Host, Cookie, Authorization, forwarded/service controls and provider-defined credential/signing collisions.
Strip response hop-by-hop, Set-Cookie, internal/service controls and upstream CORS policy; preserve remaining useful native fields and intentionally returned provider-created credentials.
Credential-based cookie providers require an explicit server adapter rather than ambient browser cookies.

Configure browser transport for actual package origins, including a verified supported opaque-origin mode where required.
A null Origin is never identity; credentialless CORS transport can expose bearer-authenticated APIs to supported opaque packages without accepting cookies as ordinary API authority.
Do not expose cookie restoration to arbitrary null-origin callers; [Access](access-connections.md#recommended-session-prototype) owns the stronger transaction/client binding and its evidence gate.
Use no-store and Vary: Origin with appropriate explicit expose headers; no shared CDN private-body cache.
CORS preflight OPTIONS is local and never dispatched, while an authorized native OPTIONS remains a provider request.
The opener validates service origin/window/transaction; the service does not pretend an opaque opener has an exact app origin.

## Native request carrier

M10 automatically sends POST to the same proxy route with `X-Integration-Method: GET` or `HEAD` when the requested native method has a supplied body, including an explicitly supplied empty body.
The public ProxyRequest and signal option do not change, and no endpoint registration or per-call transport option is required.
M08 accepts that control only on the authenticated proxy POST route, only once and only with GET or HEAD; other values, duplicates or use on another method/route are invalid wire input.
M08 consumes the control and passes the original method separately to M05, which sends that method and the raw streamed body upstream after the ordinary authorization/destination checks.
Without the control, POST remains an ordinary native POST.
The service does not reinterpret a native request body as JSON/base64 or use query/body fields as alternate method controls.
The carrier has the same no-store, CORS, authority and no-replay rules as other proxy requests.

For FormData, leave the physical Content-Type unset in the SDK so the browser generates the multipart boundary, and forward that generated Content-Type with the unchanged multipart bytes.
Reject a caller-supplied provider Content-Type with FormData rather than sending a mismatched boundary; raw pre-encoded multipart bytes may instead carry their explicit native Content-Type.
For other body types, a valid explicit provider Content-Type takes precedence over a browser-generated default; otherwise use the physical body's generated type when present.
Only this body Content-Type default is imported from browser request headers; other provider fields come from the validated tunnel, not arbitrary ambient browser headers.
M08/M05 regenerate correct outbound framing rather than trusting a caller-supplied Content-Length or Transfer-Encoding.
No file-wide conversion or server body accumulation is needed to select the carrier.

## Native response carrier

M05 disables automatic upstream redirect following.
M08 uses a 200 HTTP carrier for every provider status from 300 through 399 and for every response to a tunneled HEAD request; other supported final responses retain their native service-wire status.
This also carries a bodyless 304 without confusing it with an instruction to follow a redirect.
The reserved `X-Integration-Response-Metadata` control contains base64url UTF-8 JSON `{version: 1, status, headers}`, where `headers` is the filtered native name/value pair list.
M08 alone sets this control and `X-Integration-Origin: provider`, and explicitly exposes both through CORS.
The metadata contains only the supported final status and safe native headers after secrecy/transport filtering and private-response policy; no body, credential or arbitrary destination authority is embedded.
M10 validates its version, shape, bounds and status against the originating request, then constructs a Response with that status, filtered headers and the carrier body stream.
The metadata cannot supply reserved control fields; M10 adds `X-Integration-Origin: provider` from the validated physical carrier and consumes the metadata control rather than exposing it as a native provider field.
Supported final statuses are 200-599, with null bodies for HEAD and bodyless statuses; informational responses are not final SDK Responses and protocol upgrades are unsupported.
A metadata carrier is valid only with physical status 200 and origin provider, and its status must be 300-399 unless the original request used the HEAD carrier.
Invalid metadata is a protocol failure, cancels/releases the carrier body and rejects without replay.

For a body-bearing carrier, send the same raw encoded representation as the ordinary proxy, with the actual Content-Encoding and valid Content-Length on the physical carrier when known.
The browser performs its normal content decoding once; M10 passes the resulting stream directly to the Response constructor and never decodes it again based on the metadata's Content-Encoding.
Native Content-Encoding/Content-Length in the reconstructed headers describe the transferred representation, as they can on an ordinary Fetch response, rather than promising the size of browser-exposed decoded bytes.
Do not put original encoding only in metadata while sending encoded bytes without a physical Content-Encoding; that would expose compressed bytes as ordinary native content.
For upstream HEAD or a bodyless native status, the carrier has no payload and no physical Content-Encoding or nonzero native Content-Length; retain permitted representation metadata only inside the control and construct the native Response with a null body.
This matters when the browser sent POST for an upstream HEAD: its native representation length must not frame a nonexistent POST response payload.
Avoid duplicate native header emission on the carrier except fields needed for correct representation transport; carrier no-store, CORS and framing are service-owned.
Metadata is bounded before commitment, while body forwarding remains incremental with backpressure and abort propagation.

The synthetic Response has an empty `url`, `type: "default"`, `redirected: false` and empty `statusText`; applications inspect native status/headers/body rather than infer a provider fetch history from those properties.
The SDK uses browser `redirect: "error"` for the service request so an unexpected front-door redirect fails without following a bearer-bearing request or returning an opaque success.
Provider redirects are observable HTTP responses under this carrier contract, not SDK rejections or automatic retries.
Safe Location disclosure is independent of authorization to follow it; future controlled server following uses the distinct M05 extension contract.


## Header budgets and control integrity

HTTP owns one shared codec/validator and one supported transport-budget profile derived from actual browser, runtime, provider-client and ingress limits.
Compute encoded controls and complete physical header sizes from validated native fields and bounded service overhead; do not maintain independent contradictory negotiated allowances.
Provider discovery may expose the nonsecret supported profile for SDK known-input validation without a new endpoint or caller override.
The SDK cannot predict browser/intermediary-added fields; server/parser/ingress enforcement remains authoritative.

Validate HTTP field syntax and byte values, CR/LF rejection, bounded pair count/decoded aggregate, exact UTF-8 JSON escaping and base64url expansion.
For an N-byte serialized value, budget `ceil(4*N/3)` encoded characters plus field names/framing and verified headroom for authorization, CORS, tracing, boundaries and other physical headers.
Response accounting includes raw upstream parser limits, filtered metadata, encoded carrier controls and any representation headers also emitted physically.
Header compression does not enlarge the supported decoded header list.
Bound encoded input before decoding and allocations, and reject oversize upstream metadata before downstream commitment while closing its resources.

Reserve every `X-Integration-*` control case-insensitively, reject duplicates/malformed versions and strip provider spoofing before generating adapter controls.
Control fields never reach the provider; neither caller headers nor provider metadata can alter service identity/method/origin rules.
Known invalid SDK input fails before dispatch; service handlers use 400 for malformed controls, 431 for request-header excess and 502 for invalid/oversize upstream headers.
Never truncate or silently drop useful native headers to fit a profile.
Early parser/ingress rejection may yield unmarked HTTP or connection failure rather than service JSON, and does not prove no provider effect.
Verify the full path in both directions.
Protocol facts follow [Fetch](https://fetch.spec.whatwg.org/), [HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110.html) and [Node HTTP](https://nodejs.org/api/http.html#httpmaxheadersize); these facts are not implementation evidence.

## Embedded browser SDK

Include the framework-independent SDK directly in the Data App package, with one service client and optional jobs/events modules.
Reuse one session/handoff manager and one carrier codec; generate public resource types from one maintained schema source, keeping server secret/claim types out of the bundle.
Expose discovery, explicit connect/static setup/disconnect, native `request`, ordinary capability `invoke`, explicit job submit/list/get/result/cancel and live subscription.
`invoke` accepts CapabilityInvocation and AbortSignal, reuses native body/header controls or serializes declared JSON arguments, and returns Response at headers; it does not generate a submission key, retain commands or poll a Job.
A missing HTTP entrypoint fails explicitly; neither a slow call nor a large response falls back to Job submission.
The developer explicitly chooses `submitJob` only for a registered durable entrypoint and its retained outcome contract.
Page-local cleanup is separate from server signout, which is not a product surface.
The SDK returns native Responses/streams without default whole-body parsing or endpoint wrappers.
Whole-body `json()`, `text()` or `blob()` is an explicit app choice, not a large-media workaround supplied by the service.

Generate a new bounded opaque key only for a new logical job; retain the exact command/key for explicit lost-admission recovery.
Use the current-owner job collection to rediscover retained work without storing private commands as long-lived browser secrets.
Expiry/interruption and cancellation status never instruct hidden business retry.
Session renewal may reconnect SSE but cannot replay provider calls or slide verified authentication time.
Safe connection readiness and deliberate provider account replacement are explicit; popup closure never means connection success.
HTML media/download navigation cannot simply attach fetch bearer headers, so actual authorized media consumption remains D04 evidence work without a reusable query-bearer shortcut.
Data Apps own returned data and deliberate cross-provider behavior; no external backend consumer or outbound notification fanout is added.

## Source lifecycle state and execution

Events persists source ID, provider registration, setup owner, verified account routing, optional connection/authority generation, source revision, state and any provider expiry/renew-after time.
Store personal owner/site or explicit operator setup authority, independently of app attribution and browser streams.
States are `configured`, `active`, `attention-required` and `retired`; verified setup/routing is required before active delivery.
Manual/Data App-owned setup has no automatic lifecycle hooks unless the provider specifically requires them.
Native setup calls alone cannot publish service audience associations.

Only configured service-managed create/renew/retire runs through the existing worker scheduler with bounded I/O/cleanup and a source claim containing token, incarnation, lease and expected source/connection revisions.
Use a durable `claimed`/`may-have-dispatched` phase before mutating external hooks, current checkout at dispatch and conditional result publication after validation/encryption outside locks.
An expired undispatched claim is replaceable; an expired or lost possibly-dispatched mutating hook becomes attention-required unless documented provider-safe recovery exists.
A short lease never proves that remote subscription creation/renewal did not occur.
No blind duplicate recreation, universal subscription engine or separate scheduler is introduced.

Retirement atomically disables local routing and advances source revision before any best-effort remote cleanup; stale callbacks/hook results cannot restore it.
Disconnect/account replacement retires only its bound sources; provider-wide sources follow their own owner.
Source expiry/attention cannot report healthy delivery, and current source revision is checked again at logical browser delivery.
No revoked secret is retained for later cleanup.
Future stronger delivery or isolation needs a justified extension; these contracts promise bounded lossy live distribution only.
