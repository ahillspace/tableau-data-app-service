# Accepted decisions for the architecture rewrite

This directory is frozen decision history, not current implementation authority.
The [current specification](../../README.md) consolidates the applicable rules without requiring this history.
Historical statuses and supersession instructions below describe their original review context.


These records preserve decisions reached with the user during the architecture walkthrough.
The canonical specification includes the REWRITE-034 consumer/provider boundary, REWRITE-035 owned queue, REWRITE-036 owner history, REWRITE-037 uploads, REWRITE-038 optional capability limits, REWRITE-039 selected payload numbers and REWRITE-040 payload caps, REWRITE-041 execution cap, REWRITE-042 signout scope and REWRITE-043 service-authentication maximum; later records govern earlier conflicting scope.
Architecture-owner mechanisms remain recommendations unless an accepted record explicitly adopts them.

| Record | Audit topic | Accepted direction |
| --- | --- | --- |
| [REWRITE-001](REWRITE-001-durable-execution.md) | D01: execution topology | Durable asynchronous execution, separate API and worker processes, and externally managed jobs. |
| [REWRITE-002](REWRITE-002-shared-provider-flows.md) | D02: provider extension | Shared protocol flows, declarative configuration, narrow optional hooks, and explicit credential-breaking changes. |

| [REWRITE-003](REWRITE-003-tableau-identity-and-sdk.md) | D03: ownership and session establishment | Tableau-backed identity through authorization code + PKCE, embedded SDK, and mandatory integration/experience validation. |
| [REWRITE-004](REWRITE-004-authorization-attachment.md) | D04: authorization attachment | Bind authorization to its initiating owner, secure completion and replacement, and allow deliberate external-account choice. |
| [REWRITE-005](REWRITE-005-credential-refresh-safety.md) | D05: credential renewal | Shared refresh coordination, stale-update fencing, durable uncertainty, and provider-specific safe recovery. |
| [REWRITE-006](REWRITE-006-helper-default-and-credential-access.md) | D06: backend credential access | Prefer the shared helper; allow explicit credential access for trusted backend integrations while preserving ownership and browser boundaries. |
| [REWRITE-007](REWRITE-007-simple-errors-and-opt-in-retries.md) | D07: errors and retries | Retries off by default, author-configurable retries, and no mandatory effect-classification or recovery framework. |
| [REWRITE-008](REWRITE-008-basic-job-deduplication.md) | D08: duplicate submissions | SDK submission IDs, atomic owner/app-scoped job admission, and protection while job records remain; no signed windows. |
| [REWRITE-009](REWRITE-009-capability-defined-pagination.md) | D09: pagination | Capability-defined paging and optional helpers, with safe provider cursor passthrough and server-held state where needed. |
| [REWRITE-010](REWRITE-010-authenticated-proxy-foundation.md) | Product interface; supersedes capability-only browser access | Authentication and native provider proxy access are foundational; managed capabilities and durable jobs are optional layers. |
| [REWRITE-011](REWRITE-011-provider-event-delivery.md) | D10: provider events | Optional provider event handling and SSE with native payloads; application-server webhook delivery superseded by REWRITE-034. |
| [REWRITE-012](REWRITE-012-maintenance-window-key-rotation.md) | D11: credential encryption | Mandatory authenticated encryption and tested maintenance-window key replacement; no online rotation requirement. |
| [REWRITE-013](REWRITE-013-standard-database-recovery.md) | X01: database recovery | Standard persistence; accept changes lost after backup restore, with no custom restore handling or runbook. |
| [REWRITE-014](REWRITE-014-tableau-preferred-cross-app-identity.md) | Ownership direction | Preserve Tableau as the possible primary option; recognize the same verified owner across apps while keeping access app-scoped. |
| [REWRITE-015](REWRITE-015-native-provider-access-by-default.md) | Native proxy scope | Native operations available within granted provider permissions; optional provider-specific restrictions, no routine endpoint allowlists. |
| [REWRITE-016](REWRITE-016-caller-controlled-proxy-retries.md) | Proxy retries | Data App and managed capability authors control business retries; credential renewal remains separate shared infrastructure. |
| [REWRITE-017](REWRITE-017-native-provider-responses.md) | Proxy responses | Preserve native statuses, bodies, and useful headers so app authors and agents use familiar provider contracts. |
| [REWRITE-018](REWRITE-018-backend-api-credentials.md) | Backend consumers | Historical acceptance superseded entirely by REWRITE-034; no external application-server consumers. |
| [REWRITE-019](REWRITE-019-single-managed-job-execution-path.md) | Execution split | All managed jobs use workers; ordinary proxy and authentication requests stay direct in the API process. |
| [REWRITE-020](REWRITE-020-job-lifetime-and-provider-revocation.md) | Job lifetime | Jobs outlive browser sessions; provider revocation blocks new submissions/starts without forced cancellation of active work. |
| [REWRITE-021](REWRITE-021-job-retention.md) | Job retention | Configurable defaults: seven days for result bodies, thirty days for terminal job records. |
| [REWRITE-022](REWRITE-022-simple-live-event-forwarding.md) | Event delivery scope | Live SSE and possible loss; application-server delivery/retries superseded by REWRITE-034; no archive/replay. |
| [REWRITE-023](REWRITE-023-connection-runtime-context.md) | Provider context | Keep validated account-specific runtime context with the connection and use it to resolve approved API destinations. |
| [REWRITE-024](REWRITE-024-provider-specific-event-lifecycle.md) | Provider events | Provider-specific setup/lifecycle, native API access, optional helpers, and SSE delivery preserving provider data. |
| [REWRITE-025](REWRITE-025-schema-setup-and-startup-order.md) | Installation and upgrades | Ordinary schema migration ownership and API/worker startup ordering using existing tooling. |
| [REWRITE-026](REWRITE-026-accepted-hardening-safeguards.md) | Final review safeguards | Encrypted auxiliary secrets, consistent credential/context checkout, refresh and proxy safety, protected optional event delivery, and ordinary schema/process ordering. |
| [REWRITE-027](REWRITE-027-persistent-service-sessions.md) | Session continuity | Secure persistence and convenient reload/new-tab/return visits; replace memory-only sessions without restoration as the default, with actual mechanism and experience gated on a prototype. |
| [REWRITE-028](REWRITE-028-trusted-tableau-site-registry.md) | Site admission | Enabled Cloud URL/site-ID pairs admit all verified site users regardless of email; a protected registry interface supports external staff-controlled enrollment. |
| [REWRITE-029](REWRITE-029-simple-provider-consent-expiry.md) | Provider consent | Restart after true session/transaction expiry or authority loss; no dedicated consent-resume or credential-staging machinery. |
| [REWRITE-030](REWRITE-030-streaming-and-large-responses.md) | Native response streaming | Incremental large/media HTTP responses; explicit proposed 5 GB configuration replaces 8 MiB, with memory/backpressure/stall protection and no short total lifetime on healthy streams. |
| [REWRITE-031](REWRITE-031-session-and-provider-lifetime-policy.md) | Lifetime policies | Long-lived, renewable service sessions under one operator-configurable policy; separate provider credential policies within provider constraints, with the numerical boundary subsequently fixed by REWRITE-043. |
| [REWRITE-032](REWRITE-032-connector-reauthorization-policy.md) | Connector reauthorization | Configurable interval per connector requiring external provider authorization again; ordinary token refresh cannot reset it, and service-session lifetime remains separate. |
| [REWRITE-033](REWRITE-033-browser-request-authentication-boundary.md) | Browser request boundary | Direct browser requests use verified identity, scoped sessions and revocation; no Tableau Cloud server-IP restriction for viewer traffic. |
| [REWRITE-034](REWRITE-034-data-app-and-provider-boundary.md) | Application-consumer scope | Data Apps own logic and initiate provider reads/writes; remove external application-server clients/grants/notification recipients and approval screens while preserving internal work and operator controls. |
| [REWRITE-035](REWRITE-035-owned-postgres-job-worker.md) | D02 job engine | Accepted and locked owned Postgres Jobs table plus bounded worker; verification tests the chosen implementation, with no pending library comparison. |
| [REWRITE-036](REWRITE-036-retained-owner-results-after-disconnect.md) | D05 owner history | Owner reads of saved job/results survive provider disconnect under current session/app/site/ownership authority and configured retention; no provider access is restored. |
| [REWRITE-037](REWRITE-037-local-file-provider-uploads.md) | D04 local-file uploads | Data App-selected local files stream through the service to providers with bounded buffering and configurable service limits; no numeric upload cap or service-owned upload UI selected. |
| [REWRITE-038](REWRITE-038-optional-capability-limit-overrides.md) | D07 job limits | Optional capability duration/input/result overrides within server bounds; omitted values inherit configurable service defaults, with payload numbers selected in REWRITE-039 and the payload model superseded by REWRITE-040 and duration model/clock origin by REWRITE-041. |
| [REWRITE-039](REWRITE-039-job-input-and-result-defaults.md) | D07 payload defaults | Selects 100 MB (100,000,000 bytes) for each payload limit; REWRITE-040 supersedes the default/ceiling model with one cap each, and REWRITE-041 subsequently settles duration. |
| [REWRITE-040](REWRITE-040-single-job-payload-caps.md) | D07 payload caps | One environment-configured server cap each for input/result, currently 100 MB each; optional trusted capability limits may only lower them, omission uses the cap and no separate default exists. |
| [REWRITE-041](REWRITE-041-job-execution-cap.md) | D07 execution cap | Environment-configured 24-hour cap from first execution start, including external waiting; optional lower capability duration, omission uses the cap and no deadline reset. |
| [REWRITE-042](REWRITE-042-no-separate-service-signout.md) | Service signout scope | No separate user-facing service logout route, SDK method or scope choice; preserve expiration, revocation, verified identity switching, provider disconnect and page-local cleanup. |
| [REWRITE-043](REWRITE-043-verified-tableau-session-maximum.md) | Service-authentication maximum | Seven days (604800 seconds) since verified Tableau authentication, environment-configurable; activity/access refresh does not extend it, new verified authentication renews authority and no separate idle policy is required. |


## Current application boundary

REWRITE-034 supersedes the earlier additional-backend consumer/delivery scope after explicit user clarification.
Only Data Apps consume this service and receive application notifications; they own application logic and may explicitly read/write through several authorized registered providers.
This service does not provide separate application-server credentials, delegated grants, approval screens or outbound notification fanout.
Provider callbacks, internal job continuation and protected operator administration remain supported.

## Authority and use

User-accepted direction governs the rewrite where it conflicts with the older proposal.
Each record separates accepted direction from implementation details that still require architecture design.
Other audit topics remain unsettled; the audit scores and recommendations alone are not user acceptance.
Record subsequent conclusions individually and add them to this index.
If a conclusion changes, preserve its history and identify the superseding record explicitly.

## Instructions for the independent rewrite

Use GOALS.md, the accepted records in this directory, and the remaining accepted requirements as the governing inputs.
Astra owns the final architecture design and substantive review under the project instructions.
Produce a coherent replacement across the architecture and component specifications rather than layering contradictory amendments onto the old text.
Preserve existing requirements unless an accepted decision explicitly changes them.
Resolve cross-cutting implications, particularly long-running authority, credential use, cancellation, retries, and external task completion.
State unresolved choices and unverified assumptions without presenting them as accepted requirements or implemented behavior.
Keep external research and third-party implementation material outside the product documentation.
Require independent review of the complete rewritten journeys before declaring design convergence.

## Verification boundary

These records capture discussion outcomes only.
No runtime implementation, provider integration, deployment, or behavioral verification is established by their acceptance.

## Proxy-first consistency review, 2026-11-08

Reviewed REWRITE-001 through REWRITE-010 for compatibility with the accepted proxy foundation.
Added scope clarifications to REWRITE-001, REWRITE-002, REWRITE-003, REWRITE-006, REWRITE-007, REWRITE-008, and REWRITE-009.
REWRITE-004 authorization attachment and REWRITE-005 credential refresh remain applicable without policy changes.
No earlier accepted direction needs reversal beyond REWRITE-010's explicit replacement of capability-only browser access.
D10 was subsequently accepted in REWRITE-011, including preservation of provider-specific event content and optional event support.
This is a decision-record consistency review, not a full semantic review of the unchanged baseline specifications or proof of implementation compatibility.

## Remaining recommendations for review

The [proposal pack](proposals/README.md) contains recommendations and reasons for the remaining choices.
They are not accepted decisions and must not silently override the records above.
