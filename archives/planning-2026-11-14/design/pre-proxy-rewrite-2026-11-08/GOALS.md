# Tableau Data App integration service

Status: initial goal baseline derived from the user's instructions.
The architecture and component specifications remain proposals until the user reviews them.

## Purpose

Provide a small, maintainable integration backend that solutions engineers can share when building Tableau Data Apps.
Data Apps use it to discover and invoke capabilities against external services, with the necessary connection and authorization machinery handled behind the interface.
The client experience resembles calling tools on an MCP server, but using the MCP protocol is not a requirement.

## Operating context

The supported clients are Tableau Data Apps running in Tableau Cloud or Server where those Data App capabilities are supported.
The viewer is already authenticated to Tableau.
Do not introduce another general-purpose end-user account system or another Tableau login.
Tableau's browser session does not itself constitute a proven credential to an external backend.
Any limits in Tableau deployment/version support must remain explicit rather than assumed verified.

One service deployment is shared by the internal solutions engineering team and serves multiple Data Apps.
There is one administrative boundary; this is not a multi-customer SaaS platform.
The team can configure the identities and URLs/origins of its Data Apps.
We need app-level configuration and activity attribution so we can tell which app uses which capability and connection.
An app ID or allowed origin is not a secret or proof of authority.

The user will decide the service's front door and how others connect/register their apps later.
Start with trusted operator-managed configuration and a narrow app-registration contract.
Do not turn this into developer tenancy, a self-service portal, corporate SSO onboarding, billing, or an identity-management project.
If a core contract needs a trusted request/connection binding, state the required boundary and its unresolved transport explicitly; do not invent a complete front door to close the gap.

## Core behavior

Keep the initial framework independent of any named external provider.
Define connection, credential, provider, capability, execution, event, and HTTP/SDK boundaries using synthetic contract scenarios.
Do not design messaging, chat, workflow-launching, CRM operations, or another provider-specific capability into the core.
A later provider implementation must have a documented path for adding its authorization behavior and capabilities without recreating shared infrastructure.

A capability declares its inputs, outputs, authorization requirements, execution identity, effect, and failure semantics.
Support the distinction between no external credentials, an explicitly configured app/service credential, and an individual delegated connection.
Individual actions should run under the individual's authorization whenever the provider supports it.
Never silently fall back from an individual identity to an app or service identity.
Not every capability requires the viewer to log in or connect a personal account.
Provider authorization may identify an external subject without creating a local human profile or developer account.

Keep secrets on the server.
A caller knowing a connection ID alone is not authorized to use that connection.
Credentials and external account identities must not be logged or disclosed beyond the minimum required safe metadata.
Requests and events can move information in both directions; event handling is a boundary to specify, not a requirement to deploy a workflow engine immediately.

## Engineering direction

The user selected Node.js LTS, strict TypeScript, Fastify, Postgres, Kysely, and modular services as the working technology direction.
Use established libraries for protocols and cryptography rather than hand-writing them.
Keep domain contracts framework-independent and persistence ownership explicit.
A separate database, service, process, plugin loader, or abstraction requires a concrete need.
Do not adopt a large platform's deployment topology merely because it supplied architectural lessons.
A browser SDK is framework-independent; optional web components and Tableau extension wrappers may later consume the same interface.
The immediate work is specifications, not runtime implementation.

## Design acceptance scenarios

1. A configured Data App discovers the capabilities enabled for it.
2. A capability using no credentials executes without forcing a personal login.
3. An app/service capability uses only its explicitly configured connection and policy.
4. A delegated capability asks for connection authorization when required, without adding a general account system.
5. Another app or execution binding cannot use a connection merely by submitting its ID.
6. Expiring, non-expiring, refreshable, API-key, and derived credentials have explicit lifecycle support or explicit unsupported results.
7. Concurrent refresh, disconnect/refresh races, interrupted authorization, and ambiguous writes have honest recovery semantics.
8. A paginated read and a write have compatible typed interfaces, safe limits, cancellation, and explicit retry policy.
9. Incoming events are verified and deduplicated before client delivery; missed delivery has a resync contract.
10. A second synthetic provider and capability can be added through documented module entrypoints without changing existing capability logic.

## Out of scope

A provider implementation, Tableau runtime implementation, user-profile system, customer tenancy, billing, agent/tool runtime, arbitrary function hosting, generic data-sync engine, visual workflow builder, administration dashboard, and production deployment are out of scope for this exercise.
Compatibility scenarios are design checks, not promises that vendor APIs or browsers have been tested.

## Research and review process

Astra owns application architecture, initial specification authoring, consequential decisions, and substantive design review.
A separate Astra reviewer challenges the design against the goals and full cross-module journeys.
GPT-6.1 Sol is reserved for application implementation after the specifications are accepted.
Luna does not author or validate substantive architecture, security contracts, or application specifications.
Begin the new architecture from the goal baseline and private reference research, then compare with prior drafts only after the independent initial design is written.
Run bounded review rounds, stopping when material contradictions are resolved or concrete external unknowns remain.
Only the architecture owner changes shared contracts.
Do not count automated agreement as user acceptance or live verification.
Future implementers receive accepted project contracts and official library/provider documentation, not third-party implementation material.
