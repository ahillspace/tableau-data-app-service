# REWRITE-006: Prefer the request helper and allow explicit credential access

Current scope clarification: [REWRITE-034](REWRITE-034-data-app-and-provider-boundary.md) preserves this credential interface only for trusted code inside our service.
It does not authorize an external secrets-broker API or separate application-server consumers.

Status: accepted by the user for the architecture rewrite.
Recorded: 2026-11-08.
Audit topic: D06.

## Decision

Strongly recommend the shared authenticated request helper for backend capability implementations.
Allow trusted backend developers to obtain credentials explicitly and use custom clients or official provider SDKs when needed.
Do not require every exceptional integration to be placed inside an authentication or signing hook solely to access credentials.
Never expose provider credentials to browser apps.

## Rationale

Official SDKs, streaming clients, file upload libraries, and provider-specific signing may require direct credential access or control of requests.
A blanket prohibition can force unnecessary adapters or reimplementation of supported provider clients.
Our trusted same-process modules are not isolated by a security sandbox, so a narrow helper interface does not by itself contain malicious installed code.
Keep the helper convenient and well documented rather than making it the only permitted integration path.

## Required boundaries

Credential access must remain scoped to the approved connection and execution context.
A custom client cannot bypass caller authorization, change the approved execution identity, or select another owner's connection.
Use the shared credential lifecycle for obtaining usable credentials rather than duplicating refresh and storage behavior.
Do not permit direct credential mutation or raw access to credential storage as an implication of this decision.
Developers using custom clients take responsibility for the protections their path replaces, including approved destinations, timeouts, cancellation, and avoiding secret leakage.
Document which execution guarantees remain enforceable and which require explicit cooperation from a custom client, particularly dispatch evidence and safe retry rules.
Do not claim helper-specific network or effect protections automatically cover requests made outside the helper.

## Required rewrite consequences

Replace the ordinary no-secret-getter prohibition with a recommended helper path and an explicit privileged server-side credential-access interface.
Document both extension paths and the obligations of custom clients.
Keep browser capabilities and connection-use authorization strict regardless of the backend request path.

## Details still to resolve

The architecture owner must define the narrow credential-access interface, its scope and lifetime, and integration with refresh coordination.
Specify how custom clients report dispatch, partial or unknown effects, retries, and cancellation without promising universal enforcement.
Determine the smallest review and validation requirements that preserve accepted authorization and outcome guarantees.

## Affected specification areas

Update architecture.md, specs/contracts.md, specs/providers-execution.md, and specs/access-connections.md.
Reconcile effect and retry contracts, decisions/choices.md, and verification.md.

## Acceptance evidence for the rewrite

Show a capability using the standard helper and another using an official SDK requiring credentials.
Both must use only their authorized connection and keep credentials out of browser responses and logs.
Trace a credential expiry and an interrupted custom-client write without duplicating renewal machinery or hiding uncertainty.

## Verification boundary

This is accepted interface direction, not an implemented credential-access or custom-client integration.

## Proxy-first compatibility clarification, 2026-11-08

The earlier reference to strict browser capabilities does not prohibit authenticated browser proxy access.
Browsers may call native provider operations through the authorized proxy but still never receive provider credentials.
Explicit raw credential access remains a trusted backend feature.

These clarifications apply REWRITE-010 and do not introduce a separate product decision.
