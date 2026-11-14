# Current limitations and evidence gaps

Status: current accepted boundaries and unverified engineering behavior, not a list of extra product restrictions.
The local application exists; [implementation status](../implementation-status.md) inventories actual Postgres/Redis/HTTP/TLS/process/browser evidence and remaining live limits.
Normative rules live in the linked contracts, and [verification](../verification.md) defines future proof.

## Current constraints and support gaps

| ID | Area | Status | Impact/configuration | Owner and verification |
| --- | --- | --- | --- | --- |
| L01 | Native responses | Streaming accepted; no arbitrary total-byte cap. | Bound physical buffers/sockets/headers/stalls and expose actual host limits. | Transport, V05/E02. |
| L02 | Local uploads | Accepted; configurable service/provider limits without selected number. | Browser bytes, native multipart, backpressure and abort. | Transport, V05. |
| L03 | Header controls | One implemented codec/profile with byte-boundary tests; deployed ingress sizing unverified. | Derived encoded/physical budgets; SDK checks only known fields. | HTTP/SDK, V05. |
| L05 | Shared capacity | Physical admission required, no usage-count quotas. | Measure concurrent JSON/results/streams and total deployment pools. | Operations, V12/E04. |
| L06 | Login/setup timing | Finite protocol/UX-dependent expiry. | No invented extra redemption window or fixed MFA duration. | Access, V01. |
| L07 | Unauthenticated allocation | Bounded actual resources, no IP/count entitlement policy. | Fail actual inability to allocate; shared NAT is not identity. | Access/HTTP, V01/E04. |
| L08 | Service authentication maximum | Seven-day configurable policy accepted. | Refresh/activity cannot extend; no inactivity/signout addition. | Access, V01. |
| L09 | Consent expiry | Contract specified. | True session/attempt expiry ends attachment; normal access renewal preserves session binding. | Connections, V03. |
| L11 | Credential mutation liveness | One shared setup/import/renewal representation and scoped uncertainty specified, timers unmeasured. | Lost exchange/rotation or discovery cannot restore affected old tokens; recovery cannot poison a newer independent bundle. | Credentials, V03/V04. |
| L12 | Worker capacity/scheduling | Core maintenance plus conditional Job/source work. | Bounded due scans; ordinary capabilities have no handler slots/claims or hint dependency. | Jobs, V06/V12. |
| L13 | Job input/result | 100 MB each, configurable with lower trusted limits. | Full serialization/copy/crypto path needs measurement. | Jobs/operations, V06/E04. |
| L14 | Execution deadline | 24-hour configurable first-start cap accepted. | External waits included, initial queue age excluded, equality expired. | Jobs, V07/V08. |
| L15 | Pending work | No pending-job quota or future-result reservation. | Actual durable storage failure is honest; waiting does not occupy execution capacity. | Operations, V06/E04. |
| L16 | External observation | Persisted read-only recovery specified. | Provider due/backoff/callback semantics, no universal cadence or resubmission. | Jobs, V07. |
| L17 | Event bytes/age | One logical payload and computed encoding budgets specified. | No ingress/forwarding mismatch; check age at receipt and delivery. | Events, V09. |
| L18 | Duplicate events | Optional bounded integration-specific dedupe. | Eviction/restart permits duplicates; not signature verification or replay guarantee. | Events, V09. |
| L19 | SSE resources | Independent byte queues and aggregate budgets. | No stream-count quota, slow readers do not block shared subscription. | Events, V09/E04. |
| L20 | SSE reconnect | Loss/resync and session coordination specified. | No business replay, no stale offline publish queue or normal browser polling fallback. | Events/SDK, V09. |
| L24 | Retention | Seven/thirty-day configurable terminal defaults. | Saved owner reads after disconnect; no timestamp extension. | Jobs, V13. |
| L25 | Cleanup/rekey | Metadata-first byte/time batches and one large envelope. | No batch loading of many maximum payloads. | Operations, V11/V13. |
| L26 | Shutdown/watchdog | Accepted worker-wide interruption, host unverified. | Hung Promise and CPU loop need different detection; confirm exit before reuse. | Operations, V12. |
| L27 | Redirect inspection | Explicit no-follow carrier specified. | Browser manual opacity handled; future following remains separate. | Transport/wire, V05. |
| L28 | Media authorization | Synthetic Chromium image decode, MediaSource range seek and small download pass; live embedding unverified. | HTML media cannot attach arbitrary SDK headers; no reusable query bearer/whole-video workaround. | Access/Transport, V01/V05. |
| L29 | Native file URLs | Data, not credential-recipient authority. | Approved destination/context/private routing still applies. | Transport, V05. |
| L30 | Encoded/range bodies | Raw encoded byte contract specified. | Preserve metadata and one browser decoding step. | Transport, V05. |
| L31 | GET/HEAD body | Generic POST carrier specified. | Actual provider/intermediary acceptance still needs proof. | HTTP/SDK, V05. |
| L33 | Local/remote cancellation | Separate bounded cleanup specified. | Issued marker fences uncertain replay; terminal result remains immutable. | Jobs, V07. |
| L34 | Early callback | Prebound context interface specified. | Otherwise lookup/redelivery required; send-before-ID remains unknown. | Jobs, V07. |
| L35 | Job rediscovery | Current-owner keyset collection specified. | Across configured apps, with current shared audience and no body loading. | Access/Jobs, V13. |
| L36 | Credential setup | OAuth/static/operator/derived contracts specified. | Advertise supported provider behavior only after real fixture/integration evidence. | Connections, V03/V04. |
| L37 | Account/grant continuity | Generation separation specified. | Unknown/new identity cannot inherit jobs; no provider ACL mirror. | Connections, V03. |
| L38 | Opaque origins/callback mode | Actual transport proof open. | Service cannot identify null opener by exact origin; Lax cookie may not support POST callback. | Access/HTTP, V01. |
| L39 | Access renewal versus denial | Shared session semantics specified. | SSE may renew valid session once; true loss stops it without replaying business requests. | SDK, V01/V09. |
| L40 | Authority concurrency | Ordinary read snapshots plus scoped transactional locks specified. | Zero-write usable routing, revoke-before/overlap, parent absence and post-wait live predicates need real proof. | Persistence, V08. |
| L41 | Connector reauth | Configurable with no invented periodic default. | Refresh does not reset; started jobs retain original authority exception. | Connections/Jobs, V03/V07. |
| L42 | Cloud and Server | Both required, separate supported journeys unverified. | Cloud separate login is partial; viewer equality is not required. | Access/SDK, V01/E01. |
| L43 | Optional Redis | Actual Redis/SSE/outage tests pass; deployed broker/network unverified. | Disabled has no client; outage degrades events only; no second relay. | Events/operations, V09/V12. |

| L44 | Ordinary capability execution | Request-bound API handler specified. | No persistence/recovery or auto-replay; uncooperative trusted code can disrupt API peers, with isolation deferred to evidence. | Providers/HTTP/Transport, V14. |
| L45 | Worker placement | Accepted initial worker retained for core maintenance. | API-owned core maintenance could permit worker omission; recommendation only, with load/recovery proof and deployment choice needed. | Architecture/operations, V12. |

## Evidence interpretation

The [identity evidence](../specs/access-connections.md#published-identity-evidence) does not establish restoration, media, account switching, long-term behavior or Server compatibility.
Earlier transport probes do not establish this service or deployed ingress.
No arbitrary quota/cap becomes justified by calling it a resource budget, and accepted policy values are not capacity benchmarks.
No host, SLA, price or traffic estimate is selected.
The implementation must report demonstrated incompatibilities and repair the affected mechanism without silently shrinking accepted journeys or adding another product.
