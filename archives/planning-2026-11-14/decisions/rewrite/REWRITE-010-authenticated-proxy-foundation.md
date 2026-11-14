# REWRITE-010: Authentication and proxy access are the foundation

Current scope: [REWRITE-034](REWRITE-034-data-app-and-provider-boundary.md) limits service consumers/recipients to Data Apps and external data integrations to providers.
References below to other application backends do not authorize service API access or notification delivery to them.

Status: accepted by the user for the architecture rewrite.
Recorded: 2026-11-08.
Scope: product interface and extension model; revises the earlier capability-only browser assumption.

## Decision

Make authentication and authenticated provider proxy access the foundation of the platform.
Allow a Data App or extension to call native provider API operations through our backend without requiring a managed capability for every endpoint.
Preserve provider paths, parameters, response formats, and errors where practical.
Managed capabilities and durable jobs remain available as optional additions for reusable operations and work that needs backend execution.
Provider-specific API knowledge can remain with the Data App author when using the proxy.

## Rationale

The platform should remove authentication and integration infrastructure work without unnecessarily replacing provider API designs.
Requiring a backend capability for every operation adds development work and restricts frontend developers without a demonstrated need.
Our service supplies the authenticated backend for frontend-only Tableau clients, while allowing other application backends to coexist.

## Relationship to earlier records

This supersedes the capability-only browser interface assumed in the baseline and referenced in REWRITE-006.
REWRITE-006 still governs trusted backend helper use and explicit credential access; browsers use the authenticated proxy and do not receive provider secrets.
REWRITE-003 still governs verified Tableau ownership and the SDK authentication journey, subject to its integration and experience validation.
REWRITE-007 retains retries off by default; proxy requests must not acquire implicit write retries.
REWRITE-008 applies to durable job submission and does not automatically impose request deduplication on ordinary proxy traffic.
REWRITE-009 remains compatible: native provider pagination may pass through safely, while managed capabilities may define their own pagination.
REWRITE-001 remains required infrastructure for accepted long-running jobs, even though ordinary proxy calls need not become jobs.

## Required boundaries

Verify caller identity, configured app access, and connection ownership before proxy use.
Keep provider credentials server-side and use the shared credential lifecycle and refresh coordination.
Restrict requests to approved provider destinations and prevent caller-controlled authorization overrides or credential forwarding to unauthorized origins.
Define app-level provider access policy without requiring a new capability implementation merely to expose each API endpoint.
A connection identifier alone is not authority to use it.
Preserve ordinary network limits and deliberate error handling without introducing a universal provider response schema.

## Required rewrite consequences

Rewrite the product overview, client API, provider registration, and extension paths around authenticated proxy access plus optional managed capabilities.
Include a complete journey where a frontend author connects a provider and calls a native API endpoint without adding backend capability code.
Separate ordinary request forwarding from durable job execution and provider event delivery.
Do not imply a request proxy automatically supplies incoming event streams, job completion tracking, or universal compatibility with provider SDK transports.
Review prior capability enablement, discovery, endpoint policy, permission checks, and SDK contracts for assumptions that require unnecessary wrappers.

## Details still to resolve

The architecture owner must define the smallest proxy request interface, response/header handling, app-level access policy, and provider configuration required for safe routing.
Specify limits and support for uploads, streaming, and other transport features rather than assuming all provider interactions are simple JSON requests.
Event delivery under D10 remains a separate decision; SSE and signed webhooks have been recommended but their final contract is not established by this record.

## Affected specification areas

Reconcile GOALS.md, PRD.md, README.md, architecture.md, all component specifications, decisions/choices.md, and verification.md.
Keep the existing baseline intact until the independent rewrite integrates the accepted records.

## Independent review requirement

Explicitly examine other places where the proposal unnecessarily restricts developers compared with the platform's intended authentication and proxy role.
Assess the native API access journey independently of the managed capability journey.
Check that optional conveniences have not become mandatory wrappers or duplicated provider API frameworks.

## Verification boundary

This records accepted architecture direction, not an implemented or tested browser-facing proxy or Tableau identity integration.
