# REWRITE-032: Configurable provider reauthorization per connector

Current scope: [REWRITE-034](REWRITE-034-data-app-and-provider-boundary.md) removes delegated application-backend access from the integration questions below.
Connector policy and the accepted running-job continuation boundary remain in force.

Status: accepted requirement during the mobile review discussion.
Recorded: 2026-11-09.

## Decision

Support a provider-reauthorization interval configurable separately for each connector registration through trusted server-side configuration.
The interval need not be short; no universal interval or numeric default is selected.
When an enabled interval expires, further interactive use of the affected connection requires the external provider's authorization flow again.
Revalidating the Tableau identity or renewing the service session alone does not satisfy that requirement.
Automatic provider credential refresh must not reset the reauthorization deadline.
Track the deadline from successful provider authorization rather than ordinary request activity or credential rotation.
The policy remains subject to the provider's own credential expiry, revocation and supported authorization mechanisms.

## Separate policy boundaries

REWRITE-031 continues to govern the service session and its server environment configuration.
The seven-day renewable service-session default discussed during review is a separate proposal, not this connector interval.
A connector deadline does not log the user out of our service or expire unrelated connections.
Keep service-session expiry, provider credential expiry/refresh and this required provider-reauthorization deadline distinct.
Do not implement this requirement by falsely changing the provider-issued token expiry or treating ordinary refresh as user authorization.

## Design impact and remaining integration

M04 Provider registry owns validated connector policy configuration; M02 Connections owns the connection-bound authorization evidence and successful reauthorization journey.
M01 Access and M03 Credentials must coordinate enforcement before affected provider use so native proxy access and credential checkout cannot bypass the deadline.
A08-A17 connection discovery/authorization views and flows, A18 proxy errors and M10 SDK recovery need to represent required provider reauthorization distinctly from a lost service session.
Exact fields, errors, endpoint changes, configuration-update effects and race handling remain design work, not newly finalized interfaces.
Do not infer a guarantee of a password or MFA prompt from starting provider authorization; each supported provider must establish what its actual flow proves.

Effects on delegated backend interactive use, shared service connections, live streams and private retained-result reads require explicit integration with D05/D07 before the policy is implemented.
The accepted job boundary below resolves the earlier admission/start and running-job policy hold; exact enforcement still requires implementation design.
This requirement does not reverse REWRITE-020 or introduce forced job cancellation; continuation of already-running work does not renew interactive access or authorize new work after the deadline.
Retain REWRITE-029's handling of expired or interrupted authorization attempts.
The existing Tableau experience test gate remains unchanged.

## Accepted long-running job behavior

The user reconfirmed that a job started with valid authority continues when the submitting service token or browser session expires before the job finishes.
REWRITE-020 already establishes this behavior; service-session expiry is not a job cancellation event or execution deadline.
The worker uses the job's persisted authorization context rather than extending or replaying the expired browser token.
Private status/result access still requires current caller authorization, and queued work retains the existing start-authority check.
Provider credential expiry is a separate condition: use supported renewal under current connection authority, or report a provider/credential failure when continuation is unavailable.
Do not promise successful completion despite provider rejection, retain revoked credentials, or switch the job to another account.
In a subsequent explicit acceptance, the user extended the continuation rule to the connector-reauthorization deadline.
A job that starts while the required connector authorization is current may continue after that interval expires, including supported provider credential refresh under its original account, permissions and current connection authority.
After the interval expires, new job submissions and queued job starts require provider reauthorization; check freshness at both admission and start.
An existing retained submission remains subject to the ordinary authorized deduplication/read path rather than being treated as a new submission.
Continuing a running job does not reset the deadline, renew a browser session, grant interactive provider use or authorize another job.
This continuation does not override explicit disconnect/revocation, replacement fencing, provider rejection, capability deadlines or existing failure/recovery rules.
Reauthorization that replaces a connection revision does not retarget an already-accepted job to a new account or authority revision.

## Verification boundary

Required future checks include crossing the configured deadline with otherwise usable credentials, refresh on either side of the deadline, reauthorization failure/success, separate connectors, and bypass attempts through proxy/helper/backend/job paths according to their resolved contracts.
Race the deadline with admission/start, continue an already-running job through ordinary refresh after the deadline, and prove that this continuation cannot admit/start another job or renew interactive access.
This record captures the accepted feature and its integration holds; no application behavior or live provider experience has been implemented or verified.
