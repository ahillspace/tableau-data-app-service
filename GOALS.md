# Tableau Data App integration service

Status: accepted user requirements and accepted architecture direction.
This document owns product policy; [PRD](PRD.md) organizes the required journeys, and component specifications own their technical contracts.
The accepted foundation is authenticated native routing, with reusable capabilities and explicitly chosen durable Jobs.
The initial worker-wide interruption tradeoff applies to background handlers; this revision separates ordinary request execution from it.
The optional-Job revision has owner consistency and generated-viewer checks; historical independent reviews cover their recorded snapshots only.
Application implementation, platform verification and user acceptance of delivered behavior remain separate milestones.

## Purpose and scope

Provide one shared, operator-controlled integration backend for Tableau Data Apps on both Tableau Cloud and Tableau Server.
These Data Apps, including their embedded integration code, are the only application clients and notification recipients.
Registered external systems are providers, not additional application consumers.
Authentication, server-side credential lifecycle and authenticated access to native provider APIs are the foundation.
A developer can use native paths, parameters, responses, errors and pagination without creating a backend capability for each endpoint.
Optional provider capabilities are reusable provider-specific code using the same authorization and transport as native requests.
Most calls and capabilities use ordinary HTTP without saved inputs/results, a Job or a separate capability permission system.
A caller explicitly chooses a supported durable Job when background execution, recoverable tracking or retained outcomes are needed, including externally managed agent tasks.
A download or large response can stream directly; size alone does not justify durability.
The Data App owns its behavior and may deliberately read from one registered provider and write through another authorized connection.
Already-admitted Jobs may continue after the page closes; events do not initiate automatic cross-provider orchestration.

Operators configure apps and providers within one administrative boundary.
App IDs select configuration/defaults, record attribution and namespace job submissions; they do not prove a package's identity or grant personal resource access.
There are no per-app feature/capability permissions or personal app-use bindings.
Personal resources belong to the verified owner within deployment/site scope and are available to that owner across configured apps.
Operator-owned shared connections have explicit verified-site/user audiences; enrolling a site never silently expands those audiences.
The existing narrow protected site registry admits all verified users of an enabled deployment/site, regardless of email, without individual or per-app enrollment.
A separately operated enrollment integration decides who may manage that registry; this service does not add a site-approval UI.

## Identity and authorization

Use a shared identity-adapter contract for deployment-specific supported Tableau authentication and server verification of deployment, stable site and stable user identity.
Do not infer ownership from browser metadata, an app ID, an opaque origin, a decoded token, an email or the existing Tableau browser cookie.
A separate verified Tableau login is sufficient; equality to the embedded viewer is not required.
Do not create local registration, passwords, a profile directory, automatic identity linking or another identity service.
Cloud and Server are required scope, with actual compatibility evidence required for each supported journey.
The published Cloud experiment proves separate verified login and site/user identity only, as bounded in [Access](specs/access-connections.md#published-identity-evidence).
It does not prove silent restoration, account switching, media, long-term behavior or Server compatibility.
No new Tableau feature request is a prerequisite of this design.

Secure sessions must support reloads, new tabs and return visits without repeated manual sign-in solely because a page closed.
The maximum interval between verified Tableau authentications is seven days (604800 seconds), configurable through operator environment settings validated before readiness.
Activity, restoration and access-token refresh do not move the verified-authentication timestamp; an expired bearer alone cannot establish new authority.
No separate inactivity policy or user-facing signout UI/API is required.
Page closure releases local resources without revoking sessions, disconnecting providers or cancelling jobs.
The actual supported handoff/restoration mechanism and account separation require published browser proof.
An opaque/null package origin cannot identify an app or justify giving a bearer to any null-origin requester.
Use supported transaction/window correlation and verify the service origin/window at the opener.

Provider identity is separate from service identity.
An owner may deliberately connect a different external account; matching emails is not required.
No-credential operations require service identity but no personal provider login; shared credentials require their explicit audience.
A failed personal operation never falls back to a shared account.
There is no external application-backend secrets broker, delegated backend consumer or separate approval product.

## Provider and execution behavior

Keep entrusted authenticators private and authenticated-encrypted at rest, including helper-derived credentials and credential-bearing context.
Intentionally returned native provider-created credentials are allowed under provider permissions; no generic mint/export classifier, response scanner or approval screen is required.
A specifically known endpoint that returns an authenticator entrusted to this service remains a narrow custody exception.
Native provider permissions govern business operations; do not mirror them as feature grants.
Use shared OAuth, static, operator-managed and derived credential lifecycles with declarative configuration and narrow provider hooks.
Publish credentials and validated routing context atomically; coordinate renewal and retain uncertainty when rotation or required discovery may have made old material unusable.
Same-account deliberate reauthorization preserves connection authority generation only when verified continuity supports it.
Credential generation and the last explicit connector-reauthentication timestamp are separate; unknown or different identity replacement cannot inherit old jobs.
Connector reauthorization intervals are configurable, with no invented periodic default when unset, and refresh never resets them.
A job started with valid authority may continue past ordinary service-session or connector freshness expiry under its original account and current connection authority.
Disconnect blocks new checkout and removes usable entrusted secrets, while preserving eligible original outcomes and retained results.

Preserve native HTTP methods, query/body conventions, response status, useful headers, errors and paging within declared browser transport support.
Use Node streaming and backpressure for ordinary local-file uploads, large media and provider HTTP streams.
No arbitrary total response-size cap is selected; provider limits and measured physical buffer/header/socket/byte resources remain bounded.
Uploads have configurable service limits within provider constraints, with no numeric upload cap or service-owned file UI.
Do not impose a short total lifetime on a healthy progressing stream.
Use the explicit browser carriers for GET/HEAD bodies and inspectable no-follow responses.
Use maintained transport/protocol libraries, approved destinations, validated runtime context, socket-time recipient checks, verified TLS and entrusted-header protection.
Allow deliberately configured private providers through scoped operator routing while protecting metadata/control endpoints and blocking credential redirection.

Neither proxy nor SDK automatically repeats business requests.
Ordinary capability invocations are not automatically retried or promoted to Jobs.
Job retries are off by default and require explicit author opt-in for settled failures; interruption never implies safe replay.
Ordinary trusted capability handlers run within the API request; background Job handlers run inside the worker process, sharing helpers or explicitly scoped custom-client checkout.
Control scheduling/database capacity is reserved, cleanup is bounded, and an independent host watchdog can force termination of a hung worker before its capacity is reused.
This accepted initial recovery boundary may interrupt sibling handlers with honest unknown outcomes and no blind replay.
Per-handler child isolation is a later extension if measured disruption warrants it.

## Jobs, events and operations

Use one Node LTS/strict TypeScript/Fastify codebase with independently replicable API and worker roles, initially one of each.
Two roles do not imply singleton execution.
Postgres through owner-specific Kysely adapters is authoritative for identity, sessions, credentials/context, Jobs/results, source state and coordination.
The worker also performs bounded core session/handoff/credential-mutation maintenance; Job scans run only while Jobs are enabled or unfinished/retained records remain, and source hooks only when configured.
Our Jobs table is the sole durable business-work queue; bounded authoritative scans and earliest-due scheduling recover work without a queue library or reliable wakeup dependency.
External tasks persist their IDs and release execution capacity while waiting; verified callbacks transition Jobs independently of Redis.

Only explicitly admitted Jobs retain execution input/results and receive the following limits; ordinary requests do not inherit them.
Job input and saved result each have one environment-configurable cap, currently 100 MB (100000000 bytes).
A trusted operation may lower either cap; omission inherits it, with no smaller default or caller override.
The configurable execution cap is 24 hours from first execution start, including external waits and retries, with lower trusted-operation limits allowed.
Initial queue age does not expire work, and progress, observation or refresh never resets its absolute deadline.
Bounded opaque submission keys prevent duplicate admission within app/owner scope while metadata remains; compare semantic commands with maintained primitives.
Default result retention is seven days and terminal metadata retention thirty days from immutable terminal completion, both configurable.
Current service identity, site and ownership/shared audience govern private reads independently of connection usability.
Do not add app/user/IP/count quotas, a pending-job quota or speculative future-result reservations.
Actual resource exhaustion must fail honestly without reporting an uncommitted job as accepted.

Optional verified provider events use lossy Redis Pub/Sub and local authenticated SSE on every API replica.
When events are disabled, instantiate no Redis client and require no Redis deployment.
Redis failure degrades events only, leaving authentication, native proxy, durable jobs and external-task callbacks available if their own dependencies are healthy.
There is no second Postgres event transport, raw-event archive, replay/outbox or Redis Streams.
One logical event payload cap applies from accepted ingress through delivery, with computed encoding/envelope budgets, bounded age and independent slow-client handling.
Source setup may be manual, Data App-owned or service-managed; hooks exist only when the enabled provider needs them, independently of browser stream lifetime.

One migration owner prepares compatible schema before traffic/claims; incompatible upgrades and encryption-key replacement may use downtime.
Offline rekey stops all writers and automatic replacement, resumes by authenticated key IDs and verifies coverage before reopening.
Ordinary Postgres durability applies; restoring an older backup accepts the lost interval without a custom restore subsystem, session-purge procedure or access-reconfirmation runbook.
No hosting platform, price, traffic level, SLA or fixed execution-slot count is selected.

## Evidence and exclusions

Use [verification](verification.md) for future platform, race, recovery, resource and operational proof.
The service is unimplemented and this document task authorizes no application installation, implementation, publication or deployment.
No customer tenancy, billing, self-service platform, workflow builder, sync engine, arbitrary code hosting, agent runtime, user directory or additional consumer type is included.
External architecture research and private review traceability remain outside product sources.
No running Nango token-vault dependency/evaluation, tenant management, service rate shaping, cooldown scheduler or fairness product is adopted.
Cross-request credential caching and per-owner Redis routing stay deferred until measured need.
