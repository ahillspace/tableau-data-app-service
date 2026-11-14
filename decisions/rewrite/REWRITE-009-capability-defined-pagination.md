# REWRITE-009: Capability-defined pagination

Status: accepted by the user for the architecture rewrite.
Recorded: 2026-11-08.
Audit topic: D09.

## Decision

Let each backend capability define its pagination inputs and outputs rather than requiring a universal public pagination protocol.
Offer reusable pagination helpers for common provider patterns without requiring their use.
Expose useful controls such as page size, sorting, filtering, and page navigation where the provider supports them.
Allow a provider cursor to pass through the browser when safe.
Keep sensitive or otherwise unsuitable provider continuation state server-side when needed.
Do not impose encrypted browser continuation tokens or a server-side cursor store on all capabilities.

## Rationale

Data App authors may need provider-specific controls and continuation behavior.
Hiding all provider pagination can add complexity while removing useful functionality.
Cursor sensitivity and pagination semantics vary by provider, so the capability contract is the appropriate place to define them.

## Required boundaries

All page requests remain subject to backend authorization, approved connection ownership, and server-side credential handling.
Do not attach credentials to an arbitrary caller-supplied next-page URL without validating its destination against provider endpoint policy.
Treat browser-returned cursor values as untrusted input and validate them according to the capability contract.
Do not disclose provider secrets through cursor or URL passthrough.
Keep page sizes and response resource use bounded using the ordinary capability limits.
Do not promise stable snapshots or page navigation features that the provider does not support.

## Required rewrite consequences

Remove universal encrypted continuation and broad cursor-invalidation requirements from the shared invocation contract.
Permit capability schemas to describe paging inputs, continuation values, results, expiry, and provider limitations.
Document the safe passthrough and server-held continuation options and provide shared helpers where they reduce repeated work.
Do not require capability authors to rebuild authentication, connection checks, or destination validation for each page.

## Details still to resolve

The architecture owner must define the minimum optional helper interfaces and criteria for safely exposing continuation values.
Define lifecycle and storage only for capabilities that actually require server-held state.
Reconcile paging input with REWRITE-008 request matching and REWRITE-001 asynchronous jobs.
No universal cursor store, token format, or retention period has been selected.

## Affected specification areas

Update specs/contracts.md, specs/providers-execution.md, specs/events-http-sdk.md, architecture.md, decisions/choices.md, and verification.md.
Remove unnecessary shared continuation-state requirements from specs/persistence-operations.md and reconcile related references.

## Acceptance evidence for the rewrite

Show one capability exposing a safe provider cursor and another protecting sensitive continuation state on the backend.
Show provider-supported paging controls reaching the Data App interface.
Reject unauthorized page requests and unsafe continuation destinations without promising unsupported snapshot consistency.

## Verification boundary

This records accepted design direction, not implemented or provider-tested pagination.

## Proxy-first compatibility clarification, 2026-11-08

For proxy calls, preserve native provider paging parameters and safe continuation values without requiring a capability schema.
Capability-defined pagination applies only when a managed capability is used.
Provider credential and destination protections remain in force on both paths.

These clarifications apply REWRITE-010 and do not introduce a separate product decision.
