# REWRITE-043: Seven-day maximum between verified Tableau authentications

Status: explicitly accepted by the user; user decision walkthrough complete.
Recorded: 2026-11-10.

## Decision

Use an expiring service session with a maximum elapsed interval of seven days (604800 seconds) since successful verified Tableau authentication.
Make that maximum configurable through operator environment variables and validate configuration before readiness; exact variable names and internal representation remain engineering choices.
This is an elapsed authentication-age boundary, not a seven-day inactivity timer.
Ordinary request activity, access-token refresh and restoration transport do not move the verified-authentication timestamp or extend the maximum.
A successful new supported verified Tableau authentication permits a new service session and boundary; an expired bearer or ordinary refresh alone is insufficient.

At expiry, re-establish authority through Tableau using the supported verified identity flow.
The existing published-Tableau identity test determines whether that flow can complete silently in the actual browser/hosting environment; this decision promises no silent behavior.
No separate account screen, user-facing service logout, scheduled manual login or additional idle-duration policy is required.
REWRITE-042's removal of separate service signout remains unchanged.

## Boundaries and state

Persist the server-verified Tableau authentication time and enforce the configured maximum independently of short-lived access material and provider credential expiry.
Current app/site/owner authority, expiration, revocation and correct account switching remain required.
Provider reauthorization intervals and provider token renewal remain separate policies and cannot renew this interactive session boundary.
Jobs already started with valid authority retain their accepted continuation behavior; session expiry does not cancel them or authorize new private browser access.
Page closure still disposes local resources without revoking server credentials, disconnecting providers or cancelling jobs.

## Supersession and remaining work

Supersede earlier seven-day proposal-only wording, rolling activity-based extension as an open policy candidate, and requirements to choose additional service-session idle/absolute lifetimes in REWRITE-027/031 and active planning.
The no-numeric-lifetime statement in REWRITE-042 describes that earlier scope correction, not the current policy.
Preserve prior decision bodies with explicit follow-up pointers.
The user decision walkthrough is complete; remaining session mechanisms, precise wire/storage contracts and platform compatibility are engineering and evidence work, not another numerical-policy approval.
The existing identity experiment remains required before production identity claims or implementation against guessed protocol support.
This acceptance does not authorize application implementation, installation or deployment.

## Verification boundary

Verify the configured 604800-second boundary from successful verified authentication, ordinary activity/refresh immediately before expiry without extension, and failure of expired-bearer-only restoration.
Verify a new session only after successful new verified Tableau authentication, including account/site changes, revocation and concurrent tabs.
Test environment configuration and actual reauthentication interaction without introducing an unaccepted idle timeout or claiming that silent restoration has passed.
No runtime, browser or provider behavior has been verified by this decision record.
