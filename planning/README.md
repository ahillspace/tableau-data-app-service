# Build design review

Status: optional-Job and read-only routing revisions integrated, with owner consistency and generated-viewer checks.
Historical independent reviews apply to earlier snapshots; runtime evidence remains pending.
No application, schema or deployment is implemented.
Architecture acceptance, document convergence, implementation verification and user acceptance of delivered behavior are separate milestones.

## Review order

| Read | Purpose |
| --- | --- |
| [Product overview](product-overview.md), [PRD](../PRD.md), [GOALS](../GOALS.md) | Required outcome and accepted policy. |
| [Decision register](decision-register.md) | Accepted mechanisms versus remaining evidence. |
| [System design](system-design.md) | Replicable roles, optional Redis, state and trust relationships. |
| [Module design](module-design.md) | M01-M10 owner/interface/invariant/recovery/extension map. |
| [API design](api-design.md) | Current route IDs through A39 (retired IDs remain absent) and linked wire contracts. |
| [Data flows](data-flows.md) | F01-F07 boundary crossings with authority/state/failure. |
| [Build plan](build-plan.md) | B00-B09 implementation slices and observable proof. |
| [Limitations](limitations-audit.md) and [verification](../verification.md) | Real support gaps and executable future gates. |

This planning pack is a linked map, not a second policy authority.
The [component specifications](../specs/contracts.md) own normative mechanisms, with [GOALS](../GOALS.md) owning policy and [verification](../verification.md) owning evidence criteria.
The [generated local review workspace](../design/review-workspace/README.md) embeds all 28 manifest documents from their exact source bytes.
Historical records remain unchanged and do not override current contracts.

## How to read status

Accepted means user-stated policy or the selected architecture, not implemented correctness.
Specified means an engineering contract is concrete enough to implement within that policy.
Evidence-needed means actual protocol/browser/provider/host behavior remains unproven; a review cannot supply it.
Partially evidenced means only the explicitly named observation is established.
Draft wire names/private layouts can be refined without a new product decision when behavior stays within the owning contract.

## Implementation authority

This work is document authoring only.
Future implementation proceeds through authorized slices, proving the affected journey before claiming support rather than requiring unrelated optional features first.
The current Cloud observation is positive separate-login evidence; both Cloud and Server support still require their actual declared journey tests.
No app feature grants, global authority row, secondary event relay or arbitrary quota may be reintroduced as an implementation convenience.
Routine engineering choices and measured tuning do not require new product approval; changes to accepted policy or material ownership/failure semantics require explicit reconciliation.
The architecture owner integrates shared contracts; reviewers propose corrections and implementation workers consume the current sources rather than historical alternatives.
