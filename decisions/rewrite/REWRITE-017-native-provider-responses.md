# REWRITE-017: Preserve native provider responses

Status: accepted by the user for the architecture rewrite.
Recorded: 2026-11-08.

## Decision

Preserve native provider response status, body, and useful response headers through the authenticated proxy.
Do not wrap every response in a platform-specific data or error schema.
Preserve native request parameters and provider conventions so developers and agents can use provider documentation and familiar examples directly.

## Rationale

The user explicitly wants agents authoring Data Apps to rely on their existing knowledge of provider APIs rather than learn a new platform response schema.
A custom common response model adds translation and distances the proxy from its purpose.
Provider API versions and current documentation still govern correctness; familiarity is not proof that an API contract has not changed.

## Required boundaries

Clearly distinguish failures originating in our service from native provider responses.
Retain only the filtering necessary to prevent disclosure of credentials and internal or unsafe transport headers.
Do not silently translate native business fields, pagination, rate-limit information, or provider error meanings.
Document any provider-specific filtering or unsupported endpoint explicitly rather than claim byte-for-byte passthrough where it is not provided.

## Relationship to earlier records

This reinforces REWRITE-010, REWRITE-015, REWRITE-009 native pagination, and REWRITE-016 caller-controlled retries.
It does not require managed capabilities or job-management responses to impersonate native provider endpoints.
Those optional platform features have their own explicit interfaces.

## Required rewrite consequences

Keep the proxy SDK thin and demonstrate native API examples with minimal connection/session additions.
Specify useful header exposure and clear service-origin error identification without a universal business-response envelope.

## Verification boundary

This records accepted response behavior, not implemented forwarding or provider compatibility.
