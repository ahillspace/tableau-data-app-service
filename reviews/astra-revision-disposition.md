# Astra revision disposition

Status: architecture-owner corrections prepared for targeted independent confirmation.
This is specification work, not user acceptance, implementation verification or a live compatibility claim.
The unchanged initial source is identified by SHA-256 `ec1f79e438f6b5dbbef97e927b7bba68d44583c0cb87b5fd7ab955224992e3ab` and commit `db58f3b`.
The revised snapshot and canonical source commit are recorded below.

## Independent findings

| Finding | Disposition and concrete change | Verification scenario |
| --- | --- | --- |
| R1 - landing authority | Accepted. `begin` returns an inert landing locator; an access-protected launch must prove the same app/holder, revalidate initiating authority and match the recovery generation before storing transaction-specific cookie correlation and returning the provider redirect. | Transfer A's locator to B and reject before cookie/redirect; trace a legitimate new popup and two independent concurrent transactions. |
| R2 - restore barrier | Accepted. An operator-controlled generation and gate outside database backups cover private reads, authorization launch/completion, event/command admission and dispatch. Old connections stay quarantined, history references are generation-bound, and reopening requires explicit current-policy and missing-write disposition. | Restore before disconnect, a completed write and feed position 100; show old reference rejection and deliberate new-generation recovery. |
| R3 - pagination seam | Accepted. Public commands carry separate page size/cursor; handlers receive only private continuation and return `HandlerResult` with private continuation. Execution owns query binding, cursor protection and final public output validation. | Trace two pages and substitute holder, base query, page size, capability version, connection epoch and recovery generation. |
| R4 - retention and response loss | Accepted. Discovery issues an owner-scoped command window before submission; admitted results return receipt timing metadata; read-only lookup distinguishes not-recorded from expired history. Expired original windows cannot create a new write after tombstone deletion. | Lose the complete response, recover by original window/key, expire output, then expire command history; never automatically renew the write's key/window. |

The connected changes live in the shared contracts, access/connection, provider/execution, HTTP/SDK/event, persistence and verification documents.
The access transport, browser compatibility and numerical timing values remain explicit external decisions; their invariants no longer depend on a reader inferring missing contracts.
No queue, worker execution model, user directory, provider-specific workflow or new deployment service was added.

## Historical comparison dispositions

The [post-freeze comparison](astra-historical-comparison.md) was considered only after independent initial authorship and does not override the goal baseline.

| Consideration | Disposition and rationale |
| --- | --- |
| Explicit event definitions/subscriptions and resync read. | Accepted narrowly. The existing feed guarantee needs a versioned schema, operator-owned audience/source association and a compatible enabled authoritative read; those now have shared types and configuration validation. The old multi-feed topology was not adopted. |
| Indefinite unresolved-write tombstones. | Not adopted. Finite retention remains explicit; the original signed command window enforces admission expiry even after history deletion, while unknown/expired history requires reconciliation. A new window/key is never automatic recovery. This provides the stated bounded guarantee without indefinite retention. |
| Restore invalidation and backup-gap handling. | Accepted for the independent R2 reason. A generation outside restored state and an explicit closed recovery gate prevent stale disclosure and history reuse; the detailed operational runbook remains deferred. |
| Uniform asynchronous execution and background retry. | Not adopted. Ordinary bounded invocations are covered by inline handlers and receipts; background continuation needs a concrete future requirement. |
| Additional cancellation endpoints and numerical defaults. | Not adopted by inheritance. The chosen inline cancellation/inspection contract is retained; numeric limits are required validated configuration, not unsupported capacity claims. |
| Durable remote-revocation cleanup queue. | Deferred. Local disconnect and honest confirmed/unsupported/unconfirmed remote status meet the stated initial requirement; stronger cleanup durability would require a targeted extension. |

## Canonical integration and checks

The canonical source now comprises README, GOALS, PRD, architecture, five shared/module specifications, the decision record and verification scenarios.
Obsolete canonical specification files were removed to avoid two competing contracts; their contents remain in Git and the historical archive branch.
The independently authored initial directory remains unchanged.
Mechanical checks cover source presence, local-file links, unchanged initial digest and diff whitespace only.
The targeted independent pass must assess the corrections semantically; no runtime tests have been represented as passing.

## Source identity

Revised aggregate SHA-256: `8c7295bda7142bd496879dad8d18ac514dd70600c817d60145183d26841049e0`.
Canonical source commit: `19f3bc05d9a79ce231f5c69686149c045f78c568`.
The revised manifest has no local-file-link errors, the initial manifest still matches its original digest, and the diff whitespace check is clean.
