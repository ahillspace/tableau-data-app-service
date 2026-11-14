# REWRITE-015: Native API access without routine endpoint restrictions

Status: accepted by the user for the architecture rewrite.
Recorded: 2026-11-08.

## Decision

Do not limit which native provider API operations a caller can use through an authorized connection by default.
The provider's granted permissions and native API behavior determine the available operations.
Introduce provider-specific operation restrictions only when explicitly chosen for that provider.
Do not require a capability wrapper or an endpoint-by-endpoint allowlist merely to make a native operation available.
Do not build mandatory per-app method/path policy as the normal integration authoring requirement.

## Rationale

The user wants an authenticated proxy that can optionally do more.
Recreating provider operation permissions would add maintenance and limit native API flexibility without an established requirement.
Provider configuration should establish authentication and permitted destinations without enumerating every business operation.

## Boundaries that remain

Authenticate the caller and verify authority to use the selected connection.
Keep provider credentials server-side and never treat a connection ID alone as authorization.
Restrict credential-bearing traffic to approved provider destinations, rather than arbitrary caller-supplied hosts.
Retain ordinary transport limits, deliberate header handling, and prevention of credential leakage.
These infrastructure protections do not require routine restrictions on native business endpoints.
Browser-facing responses must still not expose stored provider credentials; any provider credential-returning administration route requires explicit consideration rather than an assumption that raw passthrough makes it safe.
Do not infer that a personal connection or successful Tableau login automatically grants access to a shared service credential.

## Relationship to earlier decisions and proposals

This refines REWRITE-010's app/provider access policy: authorize access to the integration and connection without requiring routine per-operation restrictions.
REWRITE-009's native provider pagination and REWRITE-007's no-automatic-retry default remain unchanged.
PROPOSAL-003's method/path restrictions are optional provider-specific choices rather than a general requirement for every app or service grant.
Any shared connection still needs explicit audience and connection-use authorization, separate from restricting individual API operations.

## Required rewrite consequences

Describe adding a provider through shared authentication, endpoint-family configuration, and optional hooks, with native API access available without operation registrations.
Document provider-specific restrictions only where a concrete requirement or credential protection need justifies them.
Remove mandatory per-endpoint or per-app operation policy machinery that exists solely to narrow otherwise authorized native API use.

## Verification boundary

This records accepted access scope, not implemented provider routing or tested credential protection.
