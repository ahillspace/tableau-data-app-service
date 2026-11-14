# REWRITE-014: Preserve Tableau identity as the preferred option

Status: accepted direction, conditional on Tableau integration and experience validation.
Recorded: 2026-11-08.
Current scope: [REWRITE-042](REWRITE-042-no-separate-service-signout.md) removes separate end-user service logout and its app-versus-global scope decision; expiration, revocation, correct-account handling and other accepted behavior remain required.

## Decision

Preserve Tableau-backed ownership as the possible primary authentication option rather than replacing it with browser-only ownership now.
The frontend is Tableau, where the viewer is already authenticated; independently establishing that identity at our backend could provide useful continuity across Data Apps.
Use the same verified Tableau deployment/site/user identity to recognize an owner across configured apps within that identity scope.
Do not assume browser-reported identity is proof or that the current Tableau login can automatically be reused without interaction.

## Rationale

The user values knowing the same person across apps without creating another user-management system.
Verified Tableau ownership can recover connections and retained jobs across sessions and browsers where authorized.
An internal ownership identifier and verified Tableau identifier mapping are sufficient; a profile directory or registration flow is unnecessary.

## Authority boundaries

Cross-app identity recognition does not itself grant cross-app access to provider connections, jobs, or events.
Retain explicit app and connection authorization, and design any deliberate cross-app sharing separately.
Do not match identities across different Tableau deployments or sites by email.
Provider authorization remains required where the provider requires it.
A verified authorizing Tableau account is not automatically proof of the viewer currently present in every open Tableau page after account changes.

## Relationship to earlier decisions and proposals

REWRITE-003 remains the conditional Tableau identity direction, supplemented by the cross-app recognition objective here.
Recent recommendations to replace Tableau authentication with browser-only ownership were not accepted and do not supersede it.
PROPOSAL-008 provides an unaccepted implementation approach for a common session core and a possible explicitly configured browser alternative.
This record does not require fully implementing both ownership modes, automatic fallback, identity linking, or owner migration.
Session transport and persistence remain separate implementation choices to validate.

## Required validation and rewrite consequences

Verify custom Tableau authorization support, stable server-verifiable identifiers, and real browser login/consent/MFA behavior before finalizing the primary option.
Include two configured apps in the experience prototype to verify same-owner recognition while preserving app-specific authorization.
Test reload, new tabs, another browser, expiry, overnight return, logout, and account switching.
Prefer reuse of existing Tableau authentication where supported, without promising no additional login or MFA.
Keep the user-accepted requirement to reconsider the approach if the actual experience is poor.
Update the identity, SDK, connection ownership, and verification sections coherently in the final rewrite.

## Verification boundary

No live Tableau identity or cross-app session flow has been tested.
This accepts a preferred direction and validation objective, not a working authentication mechanism or automatic cross-app credential sharing.
