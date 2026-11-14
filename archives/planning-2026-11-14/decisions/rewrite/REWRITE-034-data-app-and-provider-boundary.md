# REWRITE-034: Data Apps own application logic; this service connects them to providers

Status: explicitly accepted by the user after the scope sanity check.
Recorded: 2026-11-10.
Current follow-up: [REWRITE-036](REWRITE-036-retained-owner-results-after-disconnect.md) settles the owner-history question left open when this scope correction was recorded.

## Decision

Tableau Data Apps, including their embedded integration code, are the only application clients and notification recipients of this service.
The external data integrations are registered providers.
There are no separate application-server API consumers, consumer API keys, personal delegation grants, backend client or outbound application-server notification/webhook delivery.
No service-owned approval screens or user approval workflow have been agreed.
Provider-required authorization remains distinct from an invented application-server delegation flow.

The Data App decides what to do with received data.
It may connect another registered provider and explicitly send data or actions through that provider using its authorized connection.
The user confirmed that cross-provider activity is supported, but must go through a Data App.
This preserves native reads and writes, custom registered provider destinations, and optional managed capabilities; it does not authorize arbitrary unregistered recipients or autonomous event-driven orchestration.
Our service handles authentication, connection authority, credential lifecycle and requested provider operations; it does not decide the application's business response to data.

## Boundaries preserved

Internal API and worker processes, managed jobs, provider-task observation and scoped credential access for trusted service code remain supported.
A job initiated and authorized through a Data App may continue after the app closes or its session/connector interval expires under REWRITE-020/032.
The caller boundary does not require a browser to stay online for each already-authorized execution step or authorize new work after expiry.
The current capability context remains scoped to its declared connection; app-directed calls to several providers do not implicitly grant a capability unrestricted multi-connection access.

Provider API calls, OAuth callbacks, verified incoming provider events and external-task completion callbacks remain supported.
Configured provider-source creation, renewal and retirement remain provider-facing lifecycle work; browser SSE remains the live application delivery path.
No notification archive, external scheduler, workflow engine or automatic provider-event-to-capability trigger is introduced.

Protected operator administration, including the already accepted staff-controlled Tableau site registry, remains a separate control plane.
Its management authority does not grant ordinary application API or provider-data access.
The service does not broker secrets for other applications; internal scoped credential checkout is not an external API.

This is supported application-consumer scope, not proof of network origin or current Tableau embedding.
REWRITE-033's direct browser request authentication, app/site/connection checks and revocation remain necessary.

## Supersession and integration

Supersede REWRITE-018's external application-backend credentials and grants entirely.
Supersede the separate application-server delivery portions of REWRITE-011/022, backend-consumer setup references in REWRITE-024, and outbound application-webhook signing/retry requirements in REWRITE-026.
Remove delegated-backend enforcement questions from REWRITE-032's active integration work.
Provider event verification, current browser audiences, bounded live delivery, possible notification loss and provider-source lifecycle remain unchanged requirements.
REWRITE-006 continues to concern trusted code inside this service, not independent application servers.
Preserve earlier decision bodies and frozen review artifacts as history with supersession pointers.
Remove the retired clients, routes, schemas, storage, build tasks and tests from active design guidance.
D05 remains only the unresolved owner-history disclosure question; it no longer includes backend reapproval or approval-screen design.

## Verification boundary

This records accepted scope and documentation reconciliation, not implemented APIs, provider behavior or runtime verification.
Future checks must prove app-directed cross-provider reads/writes use each intended connection's authority, preserve started-job continuation, and expose neither external consumer authority nor automatic business actions from provider events.
