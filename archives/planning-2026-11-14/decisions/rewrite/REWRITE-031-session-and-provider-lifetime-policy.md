# REWRITE-031: Separate service-session and provider credential lifetime policies

Status: accepted direction during the mobile review discussion.
Recorded: 2026-11-09.
Lifetime follow-up: [REWRITE-043](REWRITE-043-verified-tableau-session-maximum.md) fixes the environment-configured seven-day maximum since verified Tableau authentication; ordinary activity/access refresh does not extend it and no separate inactivity policy is required.
Current scope: [REWRITE-042](REWRITE-042-no-separate-service-signout.md) removes separate end-user service logout and its app-versus-global scope decision; expiration, revocation, correct-account handling and other accepted behavior remain required.

## Decision

Keep one service-session policy, configurable by the service operator, separate from provider credential policies.
Expose service-session lifetime configuration through server environment variables, validated before readiness under the existing configuration contract.
The exact variable names and duration units follow the selected session mechanism; no new configuration API or browser-controlled timeout is required.
Prefer a long-lived, renewable service session that preserves the convenient return visits accepted in REWRITE-027.
No twelve-hour cutoff or other numeric lifetime is selected.
Provider definitions declare supported credential lifetime and renewal behavior, with configuration controlling choices permitted by that provider.
Provider credentials may have short lifetimes or no expiry where supported; configuration cannot extend provider-issued validity or undo revocation.
Ordinary service access-token renewal must not force a new provider login solely because that access token expired.

## Impact and boundaries

This preserves M01 Access ownership of service sessions and M03 Credentials/M04 Provider registry ownership of provider credential behavior.
A01-A07 remain the service-session journey, independent of the provider selected for a later request.
Do not introduce a separate service session per provider or choose the service lifetime from the shortest or longest provider lifetime.
One app can use several providers, and private retained-job access need not involve a current provider connection.
Provider expiry is therefore not a substitute for service-session expiration, logout, revocation or current app/site authorization.
Long-lived service access does not keep an expired or revoked provider credential usable.

## Remaining evidence and choices

The service-session mechanism, numeric idle/absolute lifetimes, rolling-renewal behavior, effects of configuration changes on existing sessions, logout scope and actual Tableau restoration experience remain unresolved under D01.
Keep verified Tableau deployment/site/user ownership and account-switch separation; browser-reported usernames are not authentication proof.
The HttpOnly restoration-session proposal remains a mechanism to evaluate, not an accepted implementation.
This record captures policy direction only; no backend, browser restoration or provider renewal behavior has been implemented or verified by this discussion.
