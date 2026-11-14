# API design

Status: specified draft route map, not implemented endpoints or a frozen public API.
[Shared contracts](../specs/contracts.md) owns public types and errors; [HTTP/SDK](../specs/events-http-sdk.md) owns codecs/carriers/CORS; [Access](../specs/access-connections.md) owns identity and resource checks.
This map supplies callers, inputs/outputs and remaining evidence without duplicating those contracts.

## Common contract

Only Cloud/Server Data Apps consume ordinary APIs and notifications; registry management and provider callbacks use separate authority.
The app route selects configured defaults, attribution and submission namespace, never personal app-use permission or package proof.
Current service identity/site plus owner equality or explicit shared audience controls private resources across configured apps.
Validate bounded opaque IDs, runtime schemas, timestamps and unknown security-sensitive controls at boundaries; native provider bodies remain outside a universal business schema.
Opaque-origin CORS is a transport configuration, not a cookie-to-bearer authorization mechanism.
Private service resources use HTTPS, no-store and safe errors; no caller may supply internal claim/owner authority.

## Endpoint inventory

All routes below are draft wire names implementing the owning contracts.
A07 and A37 intentionally await actual browser evidence; they are not implemented or silently resolved by this document.

| ID | Method and path | Caller | Input -> response | Owner | Hold |
| --- | --- | --- | --- | --- | --- |
| A01 | POST `/v1/session/transactions` | Unauthenticated SDK bootstrap | Configured app/deployment and initiation-proof verifier -> inert locator/expiry | M01/M08 | D01/E01; bounded physical allocation, no IP/count quota. |
| A02 | GET `/v1/session/transactions/:id/launch` | Browser navigation | Locator -> inert service-origin page | M01/M08 | D01; locator alone cannot start authentication. |
| A03 | POST `/v1/session/transactions/:id/launch` | Bound popup bootstrap | Initiation proof and supported browser correlation -> configured identity redirect | M01/M08 | D01; no exact-origin identification of null opener. |
| A04 | GET or POST `/v1/session/callback/:adapter` | Identity callback | Supported response/state/browser proof -> safe completion | M01/M08 | E01; actual callback mode and replica-safe single claim. |
| A05 | POST `/v1/session/transactions/:id/redeem` | Initiating SDK | Single-use initiation proof -> verified service access and safe identity | M01/M08 | D01; no bearer in URL or arbitrary null-origin cookie redemption. |
| A07 | Session restore/renew - path intentionally unset | Supported returning-client transport | Proven client/session binding -> current access or verified authentication required | M01/M10 | D01/E01; returning-client proof must be demonstrated, seven-day maximum fixed. |
| A08 | GET `/v1/apps/:app/providers` | Verified viewer | Configured context -> supported registrations, setup modes/endpoints and transport profile | M04/M01 | Configuration discovery, not feature permission grants. |
| A09 | GET `/v1/apps/:app/connections` | Verified viewer | Optional provider filter -> own and explicitly shared safe connections | M02/M01 | Owner equality across configured apps; current shared site/user audience. |
| A10 | GET `/v1/apps/:app/connections/:id` | Verified viewer | Locator -> safe state/readiness | M02/M01 | Non-visible equals absent; no credential/context disclosure. |
| A11 | POST `/v1/apps/:app/authorizations` | Personal owner | Declared setup and optional expected-generation replacement -> 201 attempt | M02 | D01/D08; reserve exact existing bundle through M03 or 409 before provider work; original owner/session binding. |
| A12 | GET `/v1/apps/:app/authorizations/:id` | Initiating owner/session | Locator -> safe status and committed connection ID | M02 | Current authority; app is attribution, not personal permission. |
| A13 | GET `/v1/authorizations/:id/launch` | Browser navigation | Locator -> inert handoff page | M02/M08 | D01; no locator-only consent. |
| A14 | POST `/v1/authorizations/:id/launch` | Bound initiating session/popup | Current proof -> correlated provider authorization | M02/M08 | D01/D08; same shared handoff, no URL bearer. |
| A15 | GET or POST `/v1/authorizations/callback/:registration` | Provider callback | Protocol/state/browser evidence -> safe completion signal | M02/M04 | D08; live exchange plus shared mutation ownership/exact bundle pair before atomic publication. |
| A16 | POST `/v1/apps/:app/authorizations/:id/cancel` | Initiating owner/session | Locator -> terminal attempt view | M02 | No remote grant rollback promise. |
| A17 | POST `/v1/apps/:app/connections/:id/disconnect` | Personal management authority | Expected authority generation -> local state and remote revoke evidence | M02 | Preserve eligible original outcomes and retained owner reads. |
| A18 | Native method or POST carrier `/v1/apps/:app/proxy/:registration/:endpoint/*path` | Verified viewer | Native query/body/header controls -> native Response/stream or explicit carrier | M05/M08/M10 | D04; GET/HEAD body carrier, inspectable no-follow responses and measured physical budgets. |
| A19 | GET `/v1/apps/:app/capabilities` | Verified viewer | Configured context -> versioned input/response schemas, supported HTTP/Job entrypoints and Job-only limits | M04/M01 | Same registration/connection authority, no feature grants or separate policy. |
| A20 | POST `/v1/apps/:app/jobs` | Verified submitter | Explicit durable choice plus opaque submission key/capability/input/selection -> 202 new or 200 equal retained JobView | M06 | D02/D07; requires a Job entrypoint, atomic semantic admission and actual resource allocation only. |
| A21 | GET `/v1/apps/:app/jobs` | Verified submitter | Own scope and optional attribution/state/capability filter -> keyset page of visible retained jobs | M06/M01 | Cross-app owner reads; no inputs/results in collection. |
| A22 | GET `/v1/apps/:app/jobs/:id` | Authorized submitter | Locator -> canonical JobView | M06/M01 | D05; current disclosure, independent of provider usability. |
| A23 | GET `/v1/apps/:app/jobs/:id/result` | Authorized submitter | Locator -> validated JSON result or not-ready/none/expired | M06/M01 | D05/D07; authorize before load and recheck before release. |
| A24 | POST `/v1/apps/:app/jobs/:id/cancel` | Authorized submitter | Locator -> current JobView with explicit cancellation request | M06 | D07; local terminal outcome distinct from remote confirmation. |
| A25 | GET `/v1/apps/:app/events` | Verified viewer | Current bearer and source/job/connection filters -> live fetch SSE | M07/M08 | Redis optional; current audience before each logical delivery; no replay. |
| A26 | Provider-defined method `/v1/providers/:registration/events/:source` | Verified provider source | Bounded exact bytes/headers/challenge -> protocol acknowledgement or failure | M07/M04 | E03; one logical payload cap and best-effort publish acceptance. |
| A27 | Provider-defined method `/v1/providers/:registration/tasks/:route` | Verified task callback | Source/task proof and original correlation -> durable transition acknowledgement | M06/M04/M08 | D07; independent of Redis, safe duplicate/late handling. |
| A31 | GET `/v1/admin/tableau-sites` | Registry-management authority | Bounded keyset filter -> configured deployment/site entries | M01/M08 | No viewer/provider authority accepted. |
| A32 | POST `/v1/admin/tableau-sites` | Registry-management authority | Configured deployment ID and stable site ID -> 201 new or 200 existing | M01/M08 | Duplicate never re-enables; no arbitrary discovery/issuer configuration. |
| A33 | PATCH `/v1/admin/tableau-sites/:id` | Registry-management authority | Enabled boolean -> committed state | M01/M08 | Identity immutable; atomic safe attribution. |
| A34 | GET `/health/live` | Host/network policy | No input -> minimal process responsiveness | M09/M08 | E05; dependency outage is not event-loop hang. |
| A35 | GET `/health/ready` | Host/network policy | No input -> core readiness and separate event status | M09/M08 | Redis outage does not fail healthy core readiness; worker exposes equivalent protected status. |
| A36 | POST `/v1/apps/:app/connections/static` | Personal owner | Provider-declared secret input and optional replacement -> safe committed connection | M02/M03/M08 | D08; write-only input, shared mutation arbitration and generation/continuity rules. |
| A37 | Media element/download authorization - surface intentionally unset | Authorized viewer | Approved native resource -> actual supported streaming consumption | M01/M05/M08/M10 | D01/D04; evidence-dependent, no reusable query bearer or whole-file workaround. |
| A39 | POST `/v1/apps/:app/capabilities/:id/versions/:version/invoke` | Verified viewer | Declared JSON arguments or native body plus connection control -> declared JSON or native Response/stream | M04/M08/M05 | Ordinary current request authority; HTTP entrypoint required, no submission key, Job row, progress or saved result. |

A38 remains retired; A39 is a new draft contract ID, preserving all existing IDs.
No service signout, backend consumer grant/approval, credential export, arbitrary destination or executable upload route exists.
Operator shared provisioning, app/provider configuration, migration and key maintenance remain protected commands, not viewer administration.
Callback methods/raw parsing follow the actual supported provider protocol rather than a universal GET/JSON assumption.

## Service resource schemas

```ts
type ConnectionView = {
  id: string;
  providerRegistrationId: string;
  ownership: "personal" | "operator";
  state: "active" | "reauthorization-required" | "renewal-uncertain" | "disconnected";
  authorityGeneration: number;
  display: { label?: string; accountLabel?: string };
  readyEndpoints: string[];
  connectorReauthRequired: boolean;
  canManage: boolean;
};
type AuthorizationBegin = {
  providerRegistrationId: string;
  inputs?: Record<string, unknown>;
  replacement?: { connectionId: string; expectedAuthorityGeneration: number };
  permissionOption?: string; // A declared provider option, never service feature permission.
};
type AuthorizationView = {
  id: string;
  status: "pending" | "exchanging" | "succeeded" | "failed" | "cancelled" | "expired";
  expiresAt: string;
  launchUrl?: string; // Inert locator, not bearer authority.
  connectionId?: string;
  error?: { code: string; message: string };
};
type StaticConnectionInput = {
  providerRegistrationId: string;
  inputs: Record<string, unknown>; // Declared secret/setup fields, accepted only as protected input.
  replacement?: { connectionId: string; expectedAuthorityGeneration: number };
};
type SiteInput = { deploymentId: string; siteId: string };
type SiteView = SiteInput & { id: string; enabled: boolean; createdAt: string; updatedAt: string };
type SitePatch = { enabled: boolean };
```

Use the single [JobSubmission/JobView](../specs/contracts.md#managed-capabilities-and-jobs) schema, without duplicate public aliases.
Credential generation, secret references, callback verifier material and private routing/task context are not exported merely because they exist internally.
Static input is never echoed; setup response is a safe ConnectionView.
For existing-connection AuthorizationBegin/StaticConnectionInput requiring provider work, the server checks expected authority generation and atomically captures current credential generation into its mutation reservation before accepting provider work.
Strictly local StaticConnectionInput instead checks the caller's expected authority generation and captures the server-owned expected pair, prepares/encrypts outside locks and uses one short writer transaction checking current authority/fixed expiry, unchanged pair and no competing reservation or uncertainty barrier before atomic publication; stale/conflicting candidates are not rebased or replayed.
The client does not choose or receive the internal mutation ID or expected credential revision.
Competing setup/import, including a reserved renewal, returns 409 `credential-mutation-in-progress`; the caller may explicitly begin again after settlement, never resume or rebase the rejected attempt.
ConnectionView readyEndpoints excludes affected endpoints while potentially invalidating work or unresolved uncertainty blocks checkout; `renewal-uncertain` covers interrupted setup/import as well as renewal.
[Credentials arbitration](../specs/access-connections.md#competing-credential-mutations) owns reservation, publication and revision-scoped recovery for viewer and operator adapters.
The operator setup adapter uses the same domain flow with explicit operator authority and audience, not A36 viewer permissions.

## Collection and result behavior

A21 scopes all results to the current submitter and current disclosure policy, with optional app-attribution filter independent of the app route's configuration.
Use bounded keyset pages ordered by `(submittedAt, id)` with a validated opaque continuation tied to filters; page size bounds response work, not user/job entitlement.
Do not load input/result bodies while listing, and do not promise a snapshot across concurrent changes.
An object endpoint can read an owner's job submitted under another configured app; the original app ID remains in JobView and the submission namespace remains unchanged.

A23 returns the capability's validated JSON result with a supported JSON media type, 409 for not-ready, 404 with a safe no-result code when no body exists, and 410 for an expired body while metadata remains.
Current owner/site/shared audience and retention are checked before body load and again before logical disclosure; provider credentials are unnecessary.
After metadata deletion, return the ordinary non-visible/absent result rather than regenerating work.
Admission has no hidden new-job count check and equal recovery does not reselect current defaults or require a still-usable provider connection.

## Native request and streaming response

A18 uses the [request carrier](../specs/events-http-sdk.md#native-request-carrier), [response carrier](../specs/events-http-sdk.md#native-response-carrier) and [header profile](../specs/events-http-sdk.md#header-budgets-and-control-integrity) unchanged.
The SDK exposes headers and incremental bodies; HTTP errors remain Responses, and late body failure can occur after resolution.
GET/HEAD bodies automatically use browser POST with original-method control; provider 3xx/tunneled HEAD uses a physical 200 carrier with validated metadata and one browser decoding pass.
Do not expect browser manual redirect mode to reveal native status/Location, follow redirects automatically or add endpoint opt-in.
No arbitrary response cap, full-file conversion or universal response wrapper is added.
Entrusted-header protection and known entrusted-secret retrieval exceptions coexist with intentionally returned native provider-created credentials.

## Ordinary capabilities

A39 maps the path reference and `X-Integration-Connection` to [CapabilityInvocation](../specs/contracts.md#managed-capabilities-and-jobs).
For declared JSON input, the body is the input value; for declared native input, body bytes and `X-Integration-Request-Headers` reuse the existing filtered transport codec, including FormData boundary handling.
The SDK never wraps a native body in JSON/base64; neither input form creates a stored command.
A19 advertises HTTP/Job support; unsupported HTTP mode/version fails with 422 before invocation, and unknown registrations/resources remain absent/non-visible.
A20 likewise rejects a definition without a Job entrypoint; neither endpoint falls back to the other.
The response is declared JSON with 200 or a native Response using the existing carrier/status/header/error contract, not JobView or an execution envelope.
M08 assigns service origin to constructed/transformed output and preserves provider origin only for unchanged M05 pass-through.
A39 supports both origins in the shared 3xx carrier, including bodyless 304; A18 remains provider-only, ordinary streamed 200 stays direct, and unexpected front-door redirects or spoofed controls gain no authority.
Null-body/framing checks, bounded metadata, precommit errors and late stream failure/disposal remain shared.
`invoke` returns Response at headers, leaving body parsing to the app; client abort/body failure/unknown remote outcome follow ordinary request semantics.
No capability-specific permissions, persisted command comparison, retries or retained-result endpoint exists on this path.
A18/A39 share the [read-only authorization projection](../specs/persistence-operations.md#ordinary-request-snapshots); later helper operations recheck current authority without changing the original connection.

## Jobs, events and operations

A20-A24 expose durable Jobs independently of optional notifications.
A27 verifies original task/correlation and commits before acknowledgement even while Redis is unavailable.
A26 acknowledges verified best-effort forwarding acceptance rather than browser delivery; provider-supported failure is required when forwarding is unavailable.
A25 returns unavailable when disabled/degraded and uses current audience/age checks plus resync signals when connected.
A35 reports core readiness separately from event readiness; A34 measures responsiveness rather than database/provider availability.
No endpoint count implies a new service, approval product or implemented support claim.

## Contract tests before API freeze

Exercise caller classes, cross-owner denial, cross-app personal access, shared-audience parent races and scope after site disablement.
Verify Cloud/Server opaque-origin handoff and restoration, native carriers/media, actual parser/ingress failures and no secret/control spoofing.
Exercise A39 JSON/native streamed input and direct JSON/stream/error/abort behavior, shared authority and absence of Job writes/replay before the optional durable tests.
Run real multi-replica admission/callback/cancel/deadline/retained-result tests, including Redis outage and large-payload control latency.
Generate route/resource types from one implementation schema only after the relevant wire behavior is proven; D01/D04 evidence-dependent surfaces remain explicit.
