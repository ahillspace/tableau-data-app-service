# REWRITE-027: Persistent service sessions and convenient return visits

Status: accepted by the user during the final review walkthrough.
Recorded: 2026-11-09.
Lifetime follow-up: [REWRITE-043](REWRITE-043-verified-tableau-session-maximum.md) fixes the environment-configured seven-day maximum since verified Tableau authentication; ordinary activity/access refresh does not extend it and no separate inactivity policy is required.
Current scope: [REWRITE-042](REWRITE-042-no-separate-service-signout.md) removes separate end-user service logout and its app-versus-global scope decision; expiration, revocation, correct-account handling and other accepted behavior remain required.

## Decision

Preserve secure service-session continuity across ordinary page reloads, new tabs and return visits within the supported session lifetime.
Users should normally resume authorized access without repeating manual sign-in solely because the page was refreshed or reopened.
Keep persistent owner/connection records separate from the browser evidence that authorizes access to them.
Restoring a service session does not inherently require reconnecting underlying provider accounts.

This supersedes the hardening recommendation that an eight-hour memory-only token with no restoration or renewal mechanism is the default session design.
Short-lived in-memory access tokens may still be part of a persistent-session mechanism; losing an access token must not by itself dictate a new manual login.
Storage, renewal, idle/absolute lifetimes and supported browser behavior remain design/prototype choices, not accepted numeric defaults.

## Security boundaries

Restoration must prove the same authorized owner and app scope, honor current policy and revocation, and preserve expiration and explicit logout.
Logout must invalidate the applicable restoration authority as well as clear the current page's token; its cross-app scope must be specified before implementation.
Persistence must not silently confuse a previously authenticated account with the Tableau account now visible in a different or switched page.
Do not weaken identity, browser binding or app/connection authorization to remove prompts.
Do not infer authorization to store long-lived bearer tokens in script-readable browser storage from this decision.
Provider credentials remain server-side, and no separate user registration or password system is introduced.

## Prototype and scope

Prove refresh, new tabs, browser restart/return visits, overnight return within the selected lifetime, logout, revocation, account switching and expired-session recovery in published Tableau Data Apps/extensions.
Measure actual prompts and browser restrictions; a platform limitation requires an explicit experience decision rather than quietly reverting to login on each page load.
Existing Tableau login does not itself prove a supported silent restoration path.
App audience policy and provider-consent transactions outlasting a service session remain separate walkthrough decisions.

This is an accepted behavior requirement, not a completed session mechanism or runtime verification.
