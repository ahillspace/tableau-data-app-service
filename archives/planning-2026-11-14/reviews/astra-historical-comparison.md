# Comparison after the independent initial freeze

Status: architecture-owner comparison, separate from the independent review and not an integration decision.
The independent initial draft was frozen at SHA-256 `ec1f79e438f6b5dbbef97e927b7bba68d44583c0cb87b5fd7ab955224992e3ab` before this comparison began.
The author then read the historical architecture, shared contracts, scenario traces and decisions, and inspected selected sections of the historical core, connection, execution and HTTP/event specifications.
No historical review conclusions were used to author the initial draft.
The frozen files remain unchanged.

## Independent choices that differ

| Area | Independent initial choice | Historical alternative | Assessment |
| --- | --- | --- | --- |
| Execution | Bounded inline handlers with durable receipts; no restart replay. | Uniform asynchronous admission, scheduling, worker claims and retries. | Inline execution satisfies the stated ordinary invocation journeys with fewer moving parts; durable background work needs a concrete future requirement. |
| Caller identity | Separate verified request binding from optional delegated holder continuity. | One app-scoped binding serves both purposes. | The separation makes session renewal and no-holder operation explicit without adding a local user profile. |
| Service connections | Operator-selected connections can be explicitly shared by several apps. | App-owned service connection records. | Explicit per-app use grants retain attribution and avoid duplicating secrets merely to share one internal credential. |
| Provider permissions | Either proven before dispatch or explicitly enforced by the provider operation. | Provider-owned granted/required authorization predicate. | The independent contract accommodates keys and APIs lacking reliable introspection while preserving app and connection authority checks. |
| Credential validity | Known, non-expiring and explicitly handled unknown expiry. | Explicit expiry or documented non-expiring only. | Unknown expiry can be supported with a reviewed validation-on-use strategy; it must never be silently treated as non-expiring. |
| Mutation shape | Bounded multiple requests with partial/uncertain effect reporting. | One logical effectful operation in the initial subset. | The goals do not require the older restriction; retries remain per-request and the core never resumes or compensates a multi-step handler automatically. |
| Browser protocol | A specific short-lived browser correlation mechanism is recommended, with live environment verification outstanding. | Callback continuity remains primarily a front-door obligation. | Authorization-flow correlation can be designed independently of general onboarding; it still cannot establish app or holder authority. |
| Remote revocation | Immediate local disconnect and best-effort remote cleanup, explicitly unconfirmed on interruption. | Restricted durable cleanup state and bounded retry work. | Durable cleanup is not yet a user requirement; the simpler contract must make its limitation visible. |

## Historical details worth testing against the new design

The historical event contract makes operator subscriptions, event schema versions and corresponding resync-read capabilities more explicit.
The independent event draft mentions those associations but does not yet give them a shared type or complete registration validation rules.
A small explicit subscription/event-definition contract would improve ownership and make the resync guarantee testable without importing the older feed topology.

The historical execution contract preserves unresolved-write tombstones until reconciliation.
The independent baseline instead states a bounded retention guarantee and disallows SDK retries after that horizon.
Retaining a compact unresolved-write tombstone until explicit disposition would provide stronger duplicate suppression for little additional machinery; this deserves review against data-retention policy and the honest ambiguity requirement.

The historical restore contract invalidates pre-restore authority through an epoch outside restored state and explicitly reconciles the backup gap.
The independent baseline correctly disables execution after restore but leaves the exact invalidation and gap procedure less concrete.
Before production implementation, restored receipts and credentials must never make old bindings, cursors or absent writes appear current.
The mechanism should remain a small operational contract rather than a new deployment platform.

The historical documents include cancellation resources, numeric defaults and additional status fields.
Those are not automatically requirements for the inline design.
Only add them where an actual client journey or verification case requires behavior not covered by the current bounded request, receipt inspection and expiry contracts.

## Integration recommendation

Treat the independently authored architecture and module layout as the proposed new basis, subject to the fresh review.
Do not combine both execution models or retain two sets of current shared contracts.
Resolve reviewer findings in a revision derived from the frozen baseline, then replace obsolete canonical specification files while preserving historical text in Git.
Preserve this comparison as evidence of what was considered, not as proof that the historical or independent design is correct.
