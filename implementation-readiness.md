# Architecture rationale and implementation readiness

Status: accepted architecture with optional-Job/read-only routing contracts integrated and owner consistency/viewer checks completed.
Historical independent reviews cover their earlier snapshots; they do not certify this revision or impose another approval gate.
The service is unimplemented; no runtime/platform/load or host recovery verification is claimed.
This map links rationale to owners and future proof without creating another normative specification.

## Decision and acceptance map

| ID | Choice and tradeoff | Owning contract | Future evidence |
| --- | --- | --- | --- |
| A01 | Verified Cloud/Server identity and persistent service sessions; actual returning-client binding remains unproven. | [Access sessions](specs/access-connections.md#recommended-session-prototype). | V01 published platform/session/account matrix. |
| A02 | One protected site registry and owner/shared audience checks; app IDs remain configuration/attribution. | [Access policy](specs/access-connections.md#app-and-connection-policy). | V02 cross-owner/site denial, cross-app owner access and parent audience races. |
| A03 | One coherent bundle and shared setup/import/renewal arbitration preserve exact revision ownership. | [Credential mutation lifecycle](specs/access-connections.md#competing-credential-mutations). | V03 two-setup/setup-renewal races, interrupted exchange/discovery and second-provider reuse. |
| A04 | Revision-scoped uncertainty preserves credential safety at the cost of provider-supported recovery or proven independent replacement. | [Renewal](specs/access-connections.md#refresh-coordination-and-interruption). | V04 dispatch/discovery/lease faults and stale recovery after newer independent publication. |
| A05 | Native encoded streaming/carriers preserve provider semantics with honest browser limits. | [Transport](specs/providers-execution.md#native-forwarding-and-transport), [wire](specs/events-http-sdk.md#native-request-carrier). | V05 actual native/browser/ingress/media path, including private routing and native new credentials. |
| A06 | Explicitly chosen Jobs and bounded scans avoid a second queue; ordinary capabilities use request execution without saved outcomes. | [Jobs](specs/providers-execution.md#durable-admission-and-execution). | V06 replica admission, claim loss, lost hints and semantic recovery. |
| A07 | Persisted external identity separates observation from submission; unknown send-before-ID remains explicit. | [External work/cancel](specs/providers-execution.md#interruption-external-tasks-and-cancellation). | V07 early callbacks, deadlines and bounded remote-cancel races. |
| A08 | Coherent ordinary read snapshots remove policy shared-lock commits; scoped locks retain mutation/background/disclosure correctness. | [Transactions](specs/persistence-operations.md#transactions-concurrency-and-failure). | V08 snapshot revoke/overlap, zero-write usable routing, post-wait time, parent absence and zero-row fences. |
| A09 | Optional Redis replaces the database event relay completely and accepts loss. | [Redis/SSE](specs/events-http-sdk.md#redis-transport-and-live-sse). | V09 multi-API delivery, age/encoding/current audience, outage/disabled mode. |
| A10 | Conditional source hooks reuse worker coordination and expose ambiguity. | [Source lifecycle](specs/events-http-sdk.md#source-lifecycle-state-and-execution). | V10 source revision/claim/uncertain dispatch tests. |
| A11 | Standard authenticated encryption and offline one-envelope rekey accept downtime. | [Encryption](specs/persistence-operations.md#encryption-and-maintenance-replacement). | V11 tamper/key coverage/interruption drills. |
| A12 | Two replicable roles, core maintenance without Jobs and conditional background scans; accepted worker-wide recovery and compatible overlap. | [Process lifecycle](specs/persistence-operations.md#schema-setup-and-process-ordering). | V12 hung Promise/CPU loop/sibling interruption and independent host proof. |
| A13 | Separate result/metadata expiry preserves finite recovery without event history. | [Retention](specs/providers-execution.md#results-and-retention). | V13 current disclosure after disconnect and expiry without execution. |

## Recommended starting limits

Only the policy values in [GOALS](GOALS.md) are selected; the heading denotes the configuration inventory, not fabricated tuning defaults.

| Owner | Accepted/configurable setting | Evidence or invariant |
| --- | --- | --- |
| Access | Seven days (604800 seconds) between verified Tableau authentications. | Activity/restoration/refresh does not slide it; no separate inactivity or signout. |
| Connections | Connector interval configurable and unset unless deliberately selected. | Explicit verified reauth only; same-account continuity separate from new identity. |
| Jobs | 100 MB (100000000 bytes) each for input and saved result; lower trusted limits allowed. | Actual serialized JSON bytes, no smaller hidden default/caller override. |
| Jobs | 24 hours from first start; lower trusted duration allowed. | Initial queue age excluded; external waiting/retries included; deadline immutable. |
| Jobs | Seven-day results, thirty-day terminal metadata. | Immutable completion time; metadata at least result retention; no active age deletion. |
| Transport | Provider/configured upload limits; no arbitrary total response cap. | Bounded backpressure/socket/header resources and measured stalls, no short healthy-stream total timeout. |
| Worker/operations | Measured active-attempt, control, pool, memory and cleanup/host timings. | No fixed slot count, pending-job quota, speculative result reservation or singleton assumption. |
| Events | One logical payload cap with computed envelope/encoding/frame budgets, age/skew and bounded queues. | Every accepted payload fits the supported delivery path; no smaller forwarding allowance. |
| Setup/renewal | Finite transaction/request/claim lifetimes from actual protocol and host evidence. | No invented IP/count quotas or lease-based safe-rotation assumption. |

Validate settings and compatible relationships before relevant readiness; disclose actual parser/ingress limitations before claiming a supported path.
Measure full near-cap JSON/crypto/driver copies and authenticated result reads alongside long streams, authentication and callbacks.
Budget all replicas/control reserves/maintenance/replacement overlap, not isolated per-process defaults.
These are engineering duties, not new product approval questions.

## Planning order and empirical gates

Follow [B00-B09](planning/build-plan.md), proving actual Cloud/Server identity/native access and second-provider reuse before optional jobs/events.
Ordinary capability invocation is proved with native helpers before Jobs, including direct result/stream/error/abort and no persistence/replay.
Jobs then proves real database/recovery/callback behavior, with source hooks only for integrations needing them.
Live native events need no Job prerequisite; worker scope is required only for configured background source hooks.
The [worker placement recommendation](architecture.md#worker-deployment-recommendation) remains a distinct nonblocking topology choice, with the accepted initial two-role deployment retained.
Host evidence includes watchdog termination, pool capacity, compatible versions and all-writer exclusion for incompatible migration/rekey.
Use maintained libraries for protocol/schema/transport/canonicalization/crypto; no running Nango token-vault adoption or evaluation remains planned.
Runtime evidence, independent document review and acceptance of delivered behavior remain separate.

## Security review boundary

Threats include forged identity, cross-owner/shared audience access, transferred setup locators, stale credential/context writes, credential redirection, replay after uncertainty, stale live delivery and resource exhaustion.
The owning contracts define tests for those boundaries; trusted installed code and operators are not sandboxed.
A later security review examines actual code/dependencies/host behavior and can still find defects.
