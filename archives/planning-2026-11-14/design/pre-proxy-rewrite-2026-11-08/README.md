# Tableau Data App integration service

Status: revised Astra-authored design proposal for one shared internal solutions engineering service.
User acceptance and implementation verification remain pending.
This repository contains specifications and review artifacts, not an implemented application.

Start with the user's [goal baseline](GOALS.md), the [product requirements and assessment](PRD.md), and the [architecture](architecture.md).
The design uses a single modular Node application and Postgres, fixed none/service/delegated execution identity, bounded inline capability execution, durable receipts and a verified event feed.
The front-door transport, tested Tableau/browser support and first real provider remain explicit dependencies.

The current contracts are:

- [Shared types and invariants](specs/contracts.md).
- [Access, connections and credentials](specs/access-connections.md).
- [Provider modules and execution](specs/providers-execution.md).
- [Events, HTTP and browser SDK](specs/events-http-sdk.md).
- [Persistence and recovery](specs/persistence-operations.md).
- [Decisions and alternatives](decisions/choices.md).
- [Verification scenarios and evidence limits](verification.md).

The independent initial proposal is preserved unchanged in [design/astra-initial](design/astra-initial/architecture.md).
Its [manifest](reviews/astra-initial-frozen.json), [fresh independent review](reviews/astra-initial-independent-review.md), [post-freeze historical comparison](reviews/astra-historical-comparison.md), and [revision disposition](reviews/astra-revision-disposition.md) record the design's provenance and corrections.
The [revised source manifest](reviews/astra-revised-source.json) identifies the canonical text prepared for targeted confirmation.
Earlier mixed-model drafts and their review history are historical evidence preserved in Git, including `archive/initial-agent-draft`; they are not the current implementation contract.
Independent review can establish document-level convergence, not user acceptance, live compatibility or application test results.
