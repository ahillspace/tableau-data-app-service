# Independent initial-design review criteria

Status: prepared by the independent Astra reviewer from `AGENTS.md` and `GOALS.md`, before reading the new design or any earlier product draft.
These questions test the existing goal baseline; they do not add product requirements.
The review will assess a frozen file set and report concrete counterexamples, affected contracts, priority, and recommended corrections.
Design convergence, user acceptance, and runtime verification remain separate outcomes.

1. **Authority without an account system.** What trusted boundary supplies the app and execution binding, and which domain operations require it?
   Knowing an app ID, origin, connection ID, external subject, or execution ID must not establish authority.
   A deferred front-door transport is acceptable; an unspecified domain authorization predicate is not.
2. **The three execution identities.** Can discovery and invocation independently express no external credentials, an explicitly configured app/service connection, and delegated authorization?
   A missing personal connection must produce an actionable result without silently selecting a service credential or forcing login for unrelated capabilities.
3. **Connection establishment and reuse.** What binds authorization initiation, callback acceptance, resulting credentials, and later use to the same permitted app and execution context?
   Test interrupted authorization, duplicate callbacks, simultaneous attempts, changed external subjects, expired bindings, and reconnecting a previously disconnected connection.
   The design must say when reuse requires new external proof without creating a local human directory.
4. **Credential lifecycle.** Does each credential family have an explicit expiry, validation, renewal, replacement, and unsupported-result contract?
   Distinguish missing expiry from known non-expiry, refresh from credential derivation, transient provider failure from revoked authorization, and external subject validation from unverified token decoding.
5. **Concurrent state transitions.** What serializes refresh and credential replacement, and what prevents stale work from publishing credentials after disconnect or a newer authorization?
   Walk through process death before and after an external credential rotation and local persistence.
   Timeouts, locks, and revisions must have defined owners and honest limits.
6. **Capability and provider extension.** Can a second synthetic provider add an authorization profile, read, write, and optional event verifier through explicit module entrypoints?
   The provider-specific logic should not duplicate shared authorization, credential storage, request limits, or execution accounting.
   Protocol and cryptographic work must have a credible established-library boundary.
7. **Invocation consistency.** Do discovery, runtime validation, typed callers, effect declarations, pagination, errors, and output validation describe the same capability version?
   Test malformed input, oversized output, invalid cursors, changed policy, and a disabled capability between discovery and invocation.
8. **External effect and retry truthfulness.** What can the service prove after cancellation, a provider timeout, a crash, or successful external work followed by local persistence failure?
   Test repeated caller submissions and an ambiguous write without assuming distributed exactly-once behavior.
   Distinguish safe retries, explicit caller retry, result replay, and a new intentional operation.
9. **Shared request boundary.** Where are deadlines, abort signals, size limits, credential injection, destination restrictions, redirect behavior, and provider error normalization enforced?
   Capability input and provider responses must not turn the backend into an arbitrary authenticated proxy.
10. **Event acceptance and delivery.** What establishes event authenticity, routing authority, duplicate identity, durable acceptance, and access to delivered events?
    Test concurrent duplicates, disconnect or policy change, delivery interruption, an expired cursor, and a missed event that requires resynchronization.
    Do not require a workflow engine to satisfy this boundary.
11. **Persistence and recovery ownership.** Does every durable record have one owner, useful invariants, bounded retention, and a recovery path that agrees with its callers?
    A restored database must not silently revive disconnected authority, replay completed writes, or claim an uninterrupted event history.
    Added processes, databases, queues, and abstractions need a concrete responsibility in this small service.
12. **Honest handoff.** Can implementers trace all ten goal scenarios across HTTP, SDK, domain, provider, credential, and persistence boundaries without inventing shared contracts?
    User requirements, recommendations, external assumptions, intentional deferrals, and unverified Tableau/browser compatibility must remain distinguishable.

Findings that could permit unauthorized execution, credential disclosure, duplicate effects presented as safe, or impossible recovery promises are material blockers.
Missing details are findings only when they force contradictory or consequential cross-module choices; routine implementation choices may remain with the implementer.
No runtime test result will be inferred from a document review.
