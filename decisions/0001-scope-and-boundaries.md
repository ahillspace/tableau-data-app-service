# Scope and boundary decisions

Status: architecture recommendations for user review, not accepted decisions or implementation claims.

## User-stated direction

- One internal shared team service serves configured Tableau Data Apps.
- No customer tenancy, required general user accounts or second Tableau login is introduced.
- The front door and app onboarding are deferred.
- Initial contracts remain provider-independent and distinguish no credentials, app identity and individual delegation.
- Node.js LTS, strict TypeScript, Fastify, Postgres and Kysely are the selected technology direction.
- The immediate deliverable is an iteratively reviewed specification, not a running service.

## Architecture recommendations

Use a modular single service and one database because the current requirements do not justify more deployment units.
Use a fixed identity mode per capability version because callers should not silently escalate from personal authorization to a shared account.
Use a server-established app-scoped binding because neither origins nor provider account IDs authenticate the caller.
Keep credential injection behind a brokered provider transport to make secret handling and revocation checks a shared responsibility.
Persist execution admission and idempotency before dispatch because interrupted requests cannot establish whether an external write occurred.
Preserve outcome uncertainty rather than claim exactly-once external effects.
Use static provider modules and schema-derived types because there is no requirement for arbitrary hosted plugins.
Start event support with verified ingestion, bounded replay and explicit resync; do not introduce a generic workflow engine.

## Open choices and blocking assumptions

| Decision or assumption | Consequence | Needed before |
| --- | --- | --- |
| Trusted front-door proof and transport | Cannot securely create TrustedContext for real Data Apps yet | Browser integration or deployment |
| Stable binding lifetime and trusted rebinding | Personal connections cannot be safely reused across sessions without a decided proof | Durable delegated connection UX |
| Tableau environment/version support and browser restrictions | No verified Cloud/Server parity, popup, cookie or cross-origin compatibility | A live Tableau client integration |
| First provider and credential semantics | Refresh rotation, expiry, scopes, idempotency and event guarantees remain adapter obligations | A concrete provider implementation |
| Secret encryption/key management and rotation | Secrets cannot be production-ready without operational ownership and recovery | Storing real credentials |
| Retention, limits and operational response | Proposed defaults need deployment capacity and data-handling review | Production operation |

No open question justifies implementing a login platform as a placeholder.
None blocks further domain specification review or isolated tests with explicit trusted fixtures.
The unresolved front door is an intentional scope boundary, not a claim that caller authentication is optional.
