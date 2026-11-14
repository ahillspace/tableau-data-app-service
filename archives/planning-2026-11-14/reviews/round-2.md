# Round 2 - Adversarial review and integration

Status: completed agent review and orchestrator integration; not user acceptance or implementation verification.
Input: [round-1-frozen-source.json](round-1-frozen-source.json), aggregate SHA-256 `a07704ab68ce1617d5c21c22fff2d3f0de9128e533d4b1a76b834bdbfa271e28`, local commit `18c0b14`.
Two Luna reviewers examined the other worker's component and complete neighboring journeys without editing source specs.
Their original findings remain in [connection review](round-2-connection-review.md) and [execution review](round-2-execution-review.md).

## Integrated corrections

| Finding group | Correction |
| --- | --- |
| Restored state can resurrect authority | Offline restore advances an external authority epoch, quarantines secrets and invalidates grants; lost write history requires reconciliation. |
| Stale callback and silent account replacement | Attempts capture app/authority/fence state, recheck validity and callback continuity, and require verified same-subject reconnect. |
| Missing browser lifecycle | Shared attempt types, connection list/read/disconnect, HTTP methods, callback response and SDK helpers are explicit. |
| Conflicting version names | SafeConnection.revision is logical authorization; internal credentialVersion is token replacement; results/cursors bind the former. |
| Open credential states and provider hooks | Closed credential/refresh states, separate authorization method and credential kind, and explicit hook inputs/unsupported behavior. |
| Unenforced effect limit and hidden write uncertainty | Broker operation allowlist and one logical effect budget, durable dispatch intent, bounded retries, no retry after cancellation, honest malformed-write-output outcome. |
| Unsafe expiry of unknown writes | Minimal unresolved-write key/outcome tombstones outlive payload retention until explicit reconciliation. |
| Missing pagination bridge | Shared page controls, handler page context and server-only continuation become opaque browser cursors. |
| Undefined SDK errors and permissive requests | SDK unwraps data/throws typed service or transport errors; unknown request fields are rejected. |
| Undefined event audience and ordering | Operator subscriptions, typed schemas/resync reads, explicit audiences and commit-safe feed-head positions with deterministic lock ordering. |
| Event redelivery versus retention | Separate source-key tombstones cover declared provider redelivery horizon beyond payload retention. |
| Compatibility claims and display metadata | Initial OAuth/key/effect/event constraints are explicit; optional reviewed owner-visible labels support safe account selection. |

Root review also identified callback authority, restore gaps, event commit ordering, unknown-output writes and authorization requirement selection.
The orchestrator selected currently enabled delegated capability requirements, bounded by reviewed operator provider configuration, as the authorization request source.
The provider combines that requirement set; callers cannot request arbitrary scopes and refresh cannot expand authority.

## New frozen baseline and remaining questions

Output: [round-2-source.json](round-2-source.json), aggregate SHA-256 `26d3a975bb9083dbe8c713df67f0296ef7ff3eed504ad7a1522ed4dc311027b9`.
The following local checkpoint contains this manifest and integrated sources; round 3 records its commit ID.
The structural check found no missing titles or broken local links.
Remaining external choices are the trusted adapter and callback continuity proof, stable binding/rebinding, Tableau environment support, first provider semantics, key/epoch operations and production retention/capacity.
These choices remain explicit blockers to implementation/deployment claims, not fabricated working mechanisms.
The final round checks complete scenarios against the frozen integrated baseline with no worker source mutation.
No runtime tests, provider integrations, browser tests or production operations were performed.
