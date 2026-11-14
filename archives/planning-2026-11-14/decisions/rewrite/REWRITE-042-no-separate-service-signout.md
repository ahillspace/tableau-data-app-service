# REWRITE-042: No separate user-facing service signout

Status: explicitly directed by the user.
Recorded: 2026-11-10.
Lifetime follow-up: [REWRITE-043](REWRITE-043-verified-tableau-session-maximum.md) fixes the environment-configured seven-day maximum since verified Tableau authentication; ordinary activity/access refresh does not extend it and no separate inactivity policy is required.

## Decision

Do not require a separate user-facing integration-service logout feature, SDK signout method, logout screen or app-versus-global signout choice.
The user closes the Data App page when finished; this does not require a new service-owned UI or workflow.
Remove the proposed service logout endpoint and its scope decision from active planning.
Restoration and renewal remain necessary for the accepted convenient-return behavior and are not logout features.

## Boundaries preserved

Closing a page disposes its local resources but does not revoke server tokens or sessions, disconnect providers or cancel already-started jobs.
Server expiration, revocation, current app/site/owner authority and account separation continue to protect requests and private data.
The direct browser-facing proxy still authenticates a verified Tableau-backed caller; app IDs and browser-reported account information do not replace that proof.
Provider disconnect remains an explicit separate operation with its existing credential and retained-history semantics.

On a detected account/site change, discard obsolete page-local authority and private cached views and establish correctly verified replacement authority before exposing the new context.
Actual host identity-change detection and restoration behavior remain platform evidence work; do not invent automatic synchronization with Tableau signout or a signout-all feature.
The chosen protocol must preserve server-side revocation and expiration enforcement without requiring an ordinary end-user logout endpoint.

## Supersession

Supersede the separate service logout feature and cross-app logout-scope requirements in REWRITE-027/031 and earlier identity/verification guidance in REWRITE-003/014/029.
Retain their session persistence, expiration, revocation, consent binding and correct-account requirements.
Retire A06, the proposed logout endpoint; retain A07, the separate restoration/renewal interface.
Earlier decision bodies and frozen reviews remain historical records with explicit supersession pointers.
This decision selects no numeric session lifetime; the seven-day proposal retains its prior unaccepted status.

## Verification boundary

Verify page-local cleanup, secure restoration, expired/revoked evidence, concurrent tabs after server revocation and account/site changes without exposing another account's data.
Verify closing the app does not disconnect providers or cancel running jobs and does not promise token revocation.
No new screen, implementation, installation or deployment is authorized, and no live identity/SDK behavior has been verified by recording this scope correction.
