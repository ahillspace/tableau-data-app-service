# Tableau Data App integration service

Status: the existing component documents are historical drafts from the earlier mixed-model exercise.
Astra is independently authoring a replacement architecture and initial specification; do not use the earlier draft as an implementation baseline.

A specification workspace for a shared internal integration backend.
Start with [GOALS.md](GOALS.md).
This workspace contains design proposals, not an implemented service.

Read the [architecture](architecture.md), [shared contracts](specs/contracts.md), and [scenario traces](specs/scenarios.md) for the proposed design.
Component details cover [app policy and provider extension](specs/core.md), [connections and credentials](specs/connections.md), [execution](specs/execution.md), and [HTTP, SDK and events](specs/http-sdk-events.md).
The [decision record](decisions/0001-scope-and-boundaries.md) distinguishes the user's direction from recommendations and deferred choices.
Recorded rounds in `reviews/` preserve agent findings and source snapshots; agent convergence is neither user acceptance nor implementation verification.
The user's latest scope takes precedence over earlier research and authentication proposals.

The three-round review record starts with [drafting](reviews/round-1.md), then [adversarial integration](reviews/round-2.md), and [final verification](reviews/round-3.md).
The final source manifest is [round-3-source.json](reviews/round-3-source.json); it identifies reviewed text, not tested application behavior.
The trusted front door, stable binding and callback proof, Tableau environment compatibility and concrete provider guarantees remain open.
