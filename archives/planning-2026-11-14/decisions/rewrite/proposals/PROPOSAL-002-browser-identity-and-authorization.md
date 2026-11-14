# PROPOSAL-002: Browser sessions and deliberate connection attachment

Status: new architecture recommendation for review, conditional on the live integration gate in REWRITE-003.
Recorded: 2026-11-08.
Scope: REWRITE-003 and REWRITE-004.

## Recommendation and why

Use a server-stored opaque session with its random bearer token held only in the SDK's memory.
Bind the session to the verified Tableau deployment/site/user identifiers and one configured app.
Store a digest of the bearer token, absolute/idle expiry, and revocation status; do not create a local user profile.
Check current app grants and connection ownership on requests, event delivery, job admission, and result disclosure.
This gives direct revocation and works with authenticated fetch and SSE without depending on third-party cookies for normal API calls.

Recommend an initial eight-hour absolute session limit and thirty-minute idle limit as tunable product defaults.
Heartbeats and delivery of unsolicited events do not count as user activity.
An app left open only to receive events will therefore need an explicit Continue/sign-in interaction after idle expiry; this convenience cost is a leading item for the user experience test.
The SDK drops its token on logout and reload; a new browser context establishes identity again through the approved Tableau flow.
Do not add persistent browser refresh tokens or cross-tab session sharing initially.
These lifetime values are proposals, not external protocol requirements or evidence that the user will accept the experience.

Use a fresh authorization flow when the session expires rather than building a separate identity-token renewal subsystem immediately.
If repeated page loads or idle expiry cause unacceptable prompts, revisit persistence using observed browser behavior before promising silent renewal.
A service-origin first-party cookie is needed for transaction correlation during authorization, but normal cross-origin API and SSE calls use the memory bearer token.
Do not use query-string bearer tokens or localStorage for service/provider credentials.

## Identity and app authority limits

OAuth establishes the Tableau account that authorized this service.
It does not prove that account is the viewer currently looking at a different Tableau frame, or that it changes when that frame logs out or switches accounts.
Display the service's connected identity using safe provider-validated metadata, support explicit service logout/account change, and discard the existing SDK context when the host reports an account/site change.
Those controls reduce confusion but do not create cryptographic synchronization with the current viewer.
Where current-viewer equality is mandatory, that remains blocked until Tableau supplies a supported verifiable binding; do not label the limitation solved by a display-name comparison or shorter session lifetime.

The browser nominates an app ID; the server authorizes the verified subject to that app using current operator policy.
Start with explicit Tableau site/subject grants, or a deliberately broader site-membership rule only if the identity adapter can actually establish membership.
Allowed origins and return URLs constrain browser interaction but do not prove which workbook or frontend code is running.
An app's service-credential policy therefore grants authority to its admitted subjects, not to possession of a public app ID.
Workbook-specific authorization remains unsupported without stronger verified evidence.
No-credential and service operations avoid a personal provider connection; they still require the backend's configured caller authority.

## Initial Tableau authorization

Keep the initial transaction bound to a secret generated and retained by the initiating SDK context, as well as the configured app, origin, return target, expiry, state, and PKCE verifier.
A locator URL alone does not complete login or deliver a session.
The backend validates the provider response and identity evidence, then issues a short-lived single-use completion handoff.
The original SDK redeems it with its initiating secret before receiving the memory session token.
Never put session tokens, provider tokens, or identity claims in the return URL.

The popup and opener exchange only the transaction identifiers and tightly scoped launch/completion proof needed by this flow.
Validate the exact message origin, expected window, transaction, and bounded lifetime at both ends; never use a wildcard message target.
The specific popup handshake and service-origin cookie settings remain provisional until tested under the actual frame sandbox and browser settings.
If a top-level fallback cannot preserve the initiating proof safely, declare that variant unsupported instead of making the locator a bearer login link.

Do not assume a Tableau access token is an identity token or can name our custom backend as its audience.
The adapter must establish supported client registration, minimum scopes, resource/audience, token validation or authoritative identity lookup, and stable site/user identifiers.
Tableau's documented hosted OAuth use establishes a working product-specific OAuth path, not automatic permission for this service's custom identity use: [official hosted service documentation](https://tableau.github.io/tableau-mcp/docs/hosted-tableau-mcp).
The chosen custom flow still needs its own evidence.

## Provider attachment and replacement

Begin a provider flow only under a live service session and current app/provider policy.
Persist the initiating session, exact app/owner, expected connection epoch if replacing, expiry, and a one-time launch claim.
The SDK opens an inert service popup and proves that same initiating session through a guarded opener handshake before launch.
Only then does the service set a transaction-specific HttpOnly Secure correlation cookie and issue the provider redirect.
A copied locator in another browser has neither the initiating session proof nor the correlation cookie needed to complete it.

At callback, require the matching transaction cookie, state, issuer, callback binding, and PKCE where supported; claim completion once before exchanging the code.
Before committing, recheck the initiating session, current app permission, and expected replacement epoch.
If the session expires or is revoked, fail the transaction and require a fresh explicit attempt.
A completion message only tells the original SDK to read authenticated server status.

Allow a different external account without comparing emails.
After successful exchange, keep newly acquired credentials pending when replacement/account choice needs confirmation, and show only safe provider-supplied account metadata to the initiating owner.
Confirming a replacement atomically advances the connection epoch and installs the new credential; concurrent replacements against the old epoch conflict.
Denial, timeout, cancellation, and failed confirmation preserve the original connection.
If stable external identity is unavailable, say that continuity could not be verified and require explicit confirmation of a new connection instead of asserting that it is the same account.
Pending credentials expire promptly and are discarded; remote cleanup is best effort and never creates a usable local connection on failure.

## Costs, alternatives, and extension

A cookie-only browser session is simpler where same-site hosting and cookie behavior are established, but that hosting assumption is currently unproven for embedded apps.
A durable browser refresh credential adds persistence and rotation obligations that are unnecessary before the first experience test.
The memory-only recommendation sacrifices reload convenience and does not eliminate exposure to compromised trusted frontend code.
No session transport solves the independent current-viewer identity limitation.

## Specification implications and completion evidence

Replace the unspecified front-door fixture in access, contracts, and SDK with this provisional session adapter and explicit app grants.
Preserve REWRITE-003's conditional acceptance, Cloud-first scope, and separate Server/Desktop validation.
Remove the baseline rule that every reauthorization must preserve an external subject; replace it with deliberate account choice and epoch-safe replacement.

Exercise published Data App and extension flows for first use, reload, another tab, expiry, logout, Tableau account switching, blocked popups, unavailable cookies, and cross-origin messages.
Test copied locators, another session of the same user, swapped callbacks, expired initiating sessions, two replacements, provider identity absence, and account-change confirmation.
Record click/prompt behavior and obtain the user's experience assessment before finalizing session persistence.
Live custom Tableau OAuth support and current-viewer/workbook binding remain unresolved external facts, not decisions to paper over in the rewrite.
