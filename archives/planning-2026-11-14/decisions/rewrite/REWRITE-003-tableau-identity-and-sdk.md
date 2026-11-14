# REWRITE-003: Tableau-backed identity and embedded browser SDK

Status: accepted direction, locked by the user, conditional on integration and experience validation.
Recorded: 2026-11-07.
Current scope: [REWRITE-042](REWRITE-042-no-separate-service-signout.md) removes separate end-user service logout and its app-versus-global scope decision; expiration, revocation, correct-account handling and other accepted behavior remain required.
Audit topic: D03 and its session-establishment dependency.

## Decision

Use Tableau Cloud authorization code flow with PKCE to establish independently verified Tableau identity at our backend.
Bind provider connection ownership and job ownership to verified Tableau deployment, site, and stable user identifiers, with app-scoped authorization.
Do not introduce separate user registration, passwords, a user directory, or another identity provider for this path.
Store the minimal ownership identifiers and session records required for authorization.
Do not accept browser-supplied usernames as proof of identity.

## Browser integration

Ship a browser SDK that developers include directly in a Data App or extension.
The SDK initiates authorization in the viewer's browser and handles completion and authenticated backend calls.
Our backend owns authorization transaction validation, PKCE coordination, callback processing, code exchange, identity verification, and service-session establishment.
No additional authentication extension is required alongside the consuming Data App or extension.
An extension we ship includes the same SDK and owns its own interface.
Provider authorization remains separate from Tableau identity establishment, and provider credentials remain server-side.

## Rationale and experience requirement

The user wants provider connections tied to their Tableau identity without managing users in our backend or asking them to create another identity.
Reuse an existing Tableau browser login where supported, but do not promise silent authorization or the absence of consent, MFA, or account selection.
The user explicitly requires testing the actual experience and trying a different approach if it is poor.
Acceptance of this direction is not acceptance of an untested or disruptive login experience.

## Required validation before finalizing the mechanism

Verify custom OAuth client configuration, callback registration, resource audience, minimum scopes, and supported token validation against the target Tableau Cloud site.
Exercise the complete flow in a published Data App and a consuming extension, rather than only a standalone browser page.
Test initial authorization, an already authenticated Tableau viewer, provider connection, reopening in another tab, session renewal, expiry, logout, and switching Tableau accounts.
Check popup restrictions, blocked or partitioned cookies, effective origins, sandbox/CSP rules, CORS, and the completion handoff.
Measure required clicks and prompts, repeated sign-in, reliability, and understandable error recovery in the intended browsers.
Record evidence and obtain user assessment of the experience; no numerical UX acceptance threshold has been agreed.
If the flow is unsupported or the experience is unacceptable, reopen the mechanism decision and evaluate alternatives against the same identity and no-separate-account requirements.
Do not silently fall back to anonymous browser ownership or weaker identity checks.

## Details still to resolve

Specify browser session transport, persistence, expiry, renewal, and secure transaction-to-client binding after integration testing.
Do not claim automatic synchronization with Tableau logout or account switching; establish actual behavior and define the required policy.
OAuth proves the account authorizing our service, not automatically the current viewer of a different or subsequently switched Tableau page.
A configured app ID or origin is not proof of workbook identity; retain explicit app authorization and resolve any stronger app-binding requirement.
Define authorization for queued jobs, external task tracking, and results independently of a browser tab remaining open.
Tableau Server and Desktop support require separate evidence and, where necessary, authentication adapters; Cloud support does not establish those environments work.

## Affected specification areas

Reconcile GOALS.md and PRD.md with the accepted Tableau identity ownership and browser SDK integration requirements.
Update architecture.md, specs/contracts.md, specs/access-connections.md, and specs/events-http-sdk.md with the identity and session boundaries.
Reconcile specs/providers-execution.md and specs/persistence-operations.md with app-scoped connection and durable job ownership.
Update decisions/choices.md and verification.md with the conditional acceptance and real-browser integration gate.

## Verification boundary

No live Tableau authorization flow, custom OAuth registration, provider connection, or cross-browser session journey has been tested under this decision.
The final independent rewrite must distinguish the accepted direction from unverified platform compatibility and unresolved mechanism details.

## Proxy-first compatibility clarification, 2026-11-08

The same verified Tableau owner, app authorization, and SDK session apply to proxy calls and managed capabilities.
A capability registration is not a prerequisite for authorizing native provider API access.

These clarifications apply REWRITE-010 and do not introduce a separate product decision.
