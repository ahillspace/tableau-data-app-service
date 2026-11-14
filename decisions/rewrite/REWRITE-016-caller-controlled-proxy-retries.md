# REWRITE-016: Callers control business-request retries

Status: accepted by the user for the architecture rewrite.
Recorded: 2026-11-08.

## Decision

Leave retry policy for native provider requests to the Data App author or the managed capability implementing the operation.
Do not add a proxy-wide business retry policy, automatic request replay, or a platform retry-classification framework.
The proxy returns the provider response or an honest transport/service error so callers can choose their next action.
Managed capability authors may define retries as already allowed by REWRITE-007.

## Credential lifecycle is separate

Retain shared credential storage, renewal, and refresh coordination under REWRITE-005.
An expired access token can often be renewed using a valid refresh token without interactive reauthorization.
Interactive reconnection is required when the provider or connection state makes renewal unavailable or unsuccessful under its supported semantics.
Do not replay the original business request implicitly as a consequence of credential renewal.
The user did not accept a new platform-wide proactive about-to-expire threshold as part of this retry discussion.
Select credential renewal behavior from provider metadata and supported protocol/library semantics during implementation; do not impose a new speculative renewal policy here.

## Rationale

A general proxy should not invent operation-specific retry behavior on behalf of the application.
The app author or managed capability knows the intended operation and can use native provider duplicate-prevention parameters where available.
Credential maintenance enables authenticated requests but does not establish that repeating a business operation is appropriate.

## Required rewrite consequences

Clarify the separation between credential renewal and caller-controlled business retries in the SDK, proxy, provider, and execution contracts.
Do not introduce a mandatory proxy retry-option API or a platform rule deciding which provider operations should retry.
Preserve ordinary errors without promising that an errored request had no remote effect.
REWRITE-008 duplicate job admission, event delivery retries, and credential renewal coordination are separate concerns and remain as previously decided or explicitly proposed.

## Verification boundary

This records accepted responsibility boundaries, not tested provider credential renewal or proxy behavior.
