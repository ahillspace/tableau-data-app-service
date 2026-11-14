# PROPOSAL-006: Explicit backend principals and connection grants

Status: new architecture recommendation for user review, resolving backend authentication left open by REWRITE-006 and REWRITE-011.
Recorded: 2026-11-08.

## Recommendation and why

Give each trusted application backend its own operator-provisioned opaque API credential and named principal.
Store only a digest of the high-entropy credential in the service, return its value once, and keep it in that backend's secret store.
Authenticate it through an Authorization header over TLS and check its enabled state and current grants on every request/dispatch.
Use explicit expiry and replacement with brief operator-controlled overlap; this is not a customer onboarding or OAuth-server project.
One internal team can provision a few credentials without introducing another identity platform.

Keep browser sessions, backend API credentials, outbound webhook signing secrets, provider credentials, and operator credentials separate.
None is interchangeable with another.
A signed webhook proves the event came from this service; it does not let the recipient invoke APIs or impersonate the Tableau owner.
A browser never receives a backend API credential.

## Grant shape

A backend principal is bound to named app IDs and explicit operations: selected provider proxy grants/service bindings, selected managed capabilities, job inspection, or selected event subscriptions.
Default a new principal to no grants.
Service operations use the exact operator-configured service connection and are attributed to the backend principal and app.
The backend cannot supply an arbitrary Tableau user ID and thereby act as that user.

Delegated connection access requires a separate grant tied to the exact connection, current authorization epoch, app, backend principal, allowed operations/event types, and expiry.
The authenticated connection owner creates or confirms that grant through an allowed app flow; the operator can restrict which backend principals are eligible.
For an explicitly trusted internal administrative use case, an operator can provision the exact grant with recorded authority, but do not grant every user's connections merely because the backend belongs to the same team.
Disconnect, connection replacement, app disablement, grant revocation, and expiry invalidate it.
Do not silently retarget a grant to a newly authorized external account.

Webhook subscriptions for private delegated events reference this grant and one preconfigured destination.
Validate it before each delivery attempt, including retries.
Service/source events use the explicitly configured backend audience rather than a delegated grant.
The same backend credential can be used for status/replay management only if those operations are granted; delivery itself does not require exposing a bearer token to the recipient.

## Frontend calls to other backends

A Data App may call a storage, PDF, or other application backend independently.
This service does not automatically authenticate those calls or turn its own browser bearer token into a general application identity token.
The other backend owns its caller authentication unless a separately designed delegation exchange is needed.
For integration work on behalf of a known connection, a preauthorized backend uses its own principal and exact connection grant rather than relaying arbitrary browser identity assertions.

Do not add a general impersonation endpoint, browser-token introspection service, client-credential OAuth server, or cross-backend account directory initially.
Those mechanisms would expand the platform beyond the concrete event/proxy consumers currently required.
A backend that only receives signed events needs a destination/signing secret and audience grant, not an unused inbound API credential.

## Credential exposure and destinations

REWRITE-006's raw provider credential checkout is for trusted server modules operating inside the approved execution context.
It does not automatically create a remote HTTP API that exports provider tokens to every authorized application backend.
An external backend can use the proxy or managed capabilities with its scoped grant.
If a real remote SDK integration requires exporting provider credentials, treat that as a separate explicit privilege and lifetime/revocation design, not a side effect of backend registration.

Webhook destinations are operator registered, HTTPS by default, and subject to the same DNS/address/redirect protections as other outbound requests.
A private-network destination needs an explicit network policy.
Do not accept arbitrary callback URLs in a browser request or forward service/browser bearer headers to a destination.

## Costs, alternatives, and completion evidence

A single team-wide API key is simpler but obscures attribution and makes narrow revocation impossible.
Mutual TLS or workload identity may become preferable if the selected host already supplies it; preserve a small backend-auth adapter so that change need not alter grants.
Do not implement multiple authentication modes before one is required.
Opaque tokens require operational secret delivery and rotation, but introduce no refresh protocol or separate account system.

Add backend principals and exact delegated grants to access/contracts/persistence, and reference them from proxy, jobs, and event delivery.
Test one backend receiving permitted events and invoking its service grant, another denied the same connection, a forged Tableau owner field, delegated grant creation/replacement/revocation, API-key rotation, and webhook signing-key separation.
The team's actual backend identities, hosting secret custody, and destination URLs are deployment inputs; no external access has been provisioned by this recommendation.
