# Decisions and alternatives

Status: architectural recommendations for review, separate from user acceptance.
User-stated requirements remain those summarized in [PRD.md](../PRD.md) and established by [GOALS.md](../GOALS.md).

| Choice | Why it fits this service | Alternative and revisit condition |
| --- | --- | --- |
| One modular Node application and Postgres. | One team and one operating boundary need clear ownership without deployment coordination. | Split a process only after a concrete isolation or capacity requirement. |
| Explicit verified app/holder contract; transport deferred. | Keeps the authority requirement precise without inventing onboarding or a login platform. | Choose a front-door adapter when the user selects how apps connect. |
| No local human profile. | Connection ownership needs an opaque proven holder, not a directory. | Add profile data only for a real user-facing requirement with explicit authority. |
| Fixed capability identity. | Preserves individual execution and makes service use deliberate. | Separate capability versions or IDs for genuinely different execution semantics. |
| Provider code plus validated configuration. | Protocol differences require small reviewed hooks while common lifecycle stays shared. | A declarative-only catalog is insufficient for genuine protocol variation; a dynamic plugin runtime is unnecessary here. |
| Internal outbound request helper, public typed capabilities. | Reuses credential/network protections while limiting what a browser can ask the service to do. | Expose a proxy only for a concrete separately authorized use case. |
| Inline handlers with durable receipts. | Supports ordinary reads/writes, duplicate requests and lost responses without a scheduler. | Add durable background execution only for accepted work that must continue after request lifetime. |
| Explicit uncertain outcomes. | A local timeout cannot establish remote failure or undo a write/token rotation. | Provider reconciliation may refine uncertainty where supported. |
| Server-issued command windows and finite tombstones. | Clients retain enforceable admission/history deadlines before dispatch, including when the response is lost. | Indefinite unresolved-write retention is unnecessary for the stated bounded guarantee; expired history requires reconciliation. |
| Recovery generation outside restored database state. | Restored rows cannot establish current authority, command history or cursor positions. | Detailed key custody and restore tooling remain operational decisions. |
| Poll a durable event feed first. | Gives replay, scoped visibility and resync using existing HTTP and Postgres. | Add SSE or another transport when latency/connection requirements justify it. |
| Static module registration. | Reviewed trusted code is enough for this internal service. | Dynamic loading or sandboxing requires a concrete third-party code-execution requirement. |

No decision selects a named external business provider or provider-specific operation.
The synthetic scenarios exercise interfaces and failure modes only.
Not adopting a background worker does not make all long-running capabilities supported: their execution contract must be designed when required.
Not choosing the front door does not make app IDs, CORS or connection IDs sufficient credentials.

## Deliberate omissions

There is no tenant hierarchy, developer account system, SSO onboarding project, billing model, administration UI, workflow builder, data-sync engine, hosted function platform, or agent runtime.
There is no promise of atomic provider snapshots, exactly-once external writes, instantaneous remote revocation, or transparent recovery from old backups.
These omissions keep guarantees aligned with evidence and do not prevent a later targeted extension.

## Review and implementation boundary

The independent initial review challenged complete cross-module journeys and state transitions.
This revised proposal addresses its four findings; targeted independent confirmation is a separate review step.
The independent initial snapshot remains preserved even when review changes the proposal.
Design convergence means material contract contradictions have been resolved or explicitly left as external dependencies.
It does not mean the user accepted the design or that implementation/browser/provider behavior has been tested.
Future implementation uses accepted product contracts and official protocol/library/provider documentation.
Private architecture research is not an implementation specification or code source.
