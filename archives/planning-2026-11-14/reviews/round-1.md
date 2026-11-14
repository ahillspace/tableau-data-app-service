# Round 1 - Component drafting

Status: completed agent drafting round; not user acceptance or implementation verification.
The orchestrator drafted architecture, app/policy/provider boundaries, shared R1 types, scenario traces and decision scope.
Two Luna workers using xhigh reasoning drafted connections and execution/HTTP/SDK/events in separate owned files.
Only the orchestrator owned shared contracts.

## Source evidence

The initial shared R1 contract SHA-256 was `cd08bc108c89955a6d157c44ff82a1a3d7c1a4bce94e525b745ce0aae8b9bf05`.
The completed source baseline is [round-1-frozen-source.json](round-1-frozen-source.json), aggregate SHA-256 `a07704ab68ce1617d5c21c22fff2d3f0de9128e533d4b1a76b834bdbfa271e28`, retrievable at local commit `18c0b14`.
The earlier [round-1-source.json](round-1-source.json) was captured before the last worker edits and is preserved as a superseded pre-freeze manifest, not the review input.
The snapshot check reported no missing document titles or broken local file links.

## Findings handed to the next round

- Drafted shared types do not yet include authorization attempt reads/cancellation, pagination controls, event subscriptions/audiences or safe disconnect cleanup metadata.
- Logical connection revisions and internal token versions need one precise naming scheme across all modules.
- A restored database cannot prove that its historical revocation state is current.
- Dispatch checks cannot make a database transaction atomic with an external provider call.
- Generic execution retention must preserve unresolved-write deduplication rather than forget uncertainty on a timer.
- A reconnect needs to check provider subject continuity rather than silently replace the selected account.
- Callback and credential state descriptions need complete, consistent transition sets.
- A connection display label, query-key limitation and OAuth support constraints need explicit decisions.

The execution draft already added rationale for persisted reads, current-policy result checks, malformed-write-output uncertainty and cancellation-aware recovery in response to initial orchestration review.
The next round independently challenges the frozen completed drafts before integration.
No application tests, dependency installation, live provider calls or Tableau runtime checks occurred.
