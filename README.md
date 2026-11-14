# Tableau Data App integration service

This repository contains the maintained specification and local implementation of one shared backend serving Tableau Data Apps on Cloud and Server.
The accepted architecture uses independently replicable API and worker roles, authoritative Postgres and optional lossy Redis Pub/Sub.
Native routing and ordinary capability calls use HTTP; saved command/result bodies, Job execution limits and retention belong only to explicitly submitted Jobs.
The Node LTS application, migrations, browser SDK and Slack native authentication/proxy example are implemented locally; no deployment is claimed.
The optional-Job and read-only routing revision has owner consistency and generated-viewer checks; historical independent reviews cover their recorded snapshots only.
Architecture acceptance, document checks and runtime/user acceptance remain separate; no additional approval is required for this specification update.

Start with the [product overview](planning/product-overview.md), [product requirements](PRD.md) and [accepted policies](GOALS.md).
Current sources contain the complete design; historical proposals/reviews do not supply defaults.

## Current specification

| Source | Authority |
| --- | --- |
| [GOALS](GOALS.md) / [PRD](PRD.md) | Accepted policy and required user journeys. |
| [Architecture](architecture.md) | Accepted topology, ownership, tradeoffs and extension boundaries. |
| [Shared contracts](specs/contracts.md) | Common types, semantic submission comparison and cross-component handoffs. |
| [Access](specs/access-connections.md) | Verified identity, sessions, registry, personal/shared authority and credential lifecycle. |
| [Providers and execution](specs/providers-execution.md) | Native transport, ordinary capability calls and explicitly selected Jobs with cancellation/recovery. |
| [Events and wire](specs/events-http-sdk.md) | Redis/SSE, source lifecycle, browser carriers and SDK. |
| [Persistence and operations](specs/persistence-operations.md) | Schemas, scoped locks, resource admission, readiness, migration and rekey. |
| [Verification](verification.md) | Full acceptance obligations and precise evidence limits. |
| [Implementation status](implementation-status.md) / [run guide](RUNNING.md) | Implemented surfaces, observed tests, remaining live evidence and runnable commands. |
| [Readiness](implementation-readiness.md) / [planning index](planning/README.md) | Linked rationale, APIs, module/flow maps, implementation sequence and unresolved empirical evidence. |

The [manifest](specification.json) lists the maintained sources, including bounded [site access](openspec/changes/tableau-site-access/proposal.md) and [native streaming](openspec/changes/native-response-streaming/proposal.md) implementation plans.
Planning maps refer to owning contracts rather than creating competing normative rules.
The [review workspace](design/review-workspace/README.md) generates a local presentation from those exact sources; it is not independently maintained policy.
[History](history.md) preserves prior reviews and frozen designs without certifying the current candidate.

The [Cloud evidence](specs/access-connections.md#published-identity-evidence) establishes separate verified login/site-user identity only.
Actual Postgres/Redis/HTTP/TLS/process tests and synthetic Chromium login/restoration/media journeys provide bounded implementation evidence.
Live Cloud/Server embedding, live Slack acceptance, long-term sessions and deployment-specific ingress/capacity/recovery remain unverified; see the implementation inventory.
Do not claim a runtime test passed because a document or viewer check passed.
Local implementation and task-scoped development setup are authorized.
Publication, deployment and Git landing remain separate actions.
