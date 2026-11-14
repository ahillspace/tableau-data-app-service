# Tableau site access design

## Context and owner

[Access](../../../specs/access-connections.md#trusted-site-registry-administration) owns registry identity, management authority and lifecycle.
[Persistence](../../../specs/persistence-operations.md#transactions-concurrency-and-failure) owns ordered locks and atomic mutation mechanics.
This slice maps those contracts to future implementation without adding an approval/enrollment product.

## Identity and interface

The configured deployment has stable internal ID, Cloud/Server adapter and controlled canonical URL/aliases.
A registry entry uniquely identifies `(deploymentId, siteId)` with enabled state and safe actor/time metadata.
URL aliases cannot silently migrate owners; operator continuity evidence is required before preserving a deployment identity through an address change.
The narrow interface accepts a configured deployment ID and stable site ID, not arbitrary issuer/discovery routing.
This corrects the former Cloud-only URL key while preserving the separately operated enrollment integration and its authority.

| Operation | Contract reference |
| --- | --- |
| GET registry | Registry-only bounded keyset safe listing. |
| POST registry | Unique validated deployment/site; 201 new or 200 existing, no implicit re-enable. |
| PATCH entry | Enabled boolean only, immutable identity. |

A dedicated registry-management secret stays in the trusted enrollment backend and has no provider-data or viewer-impersonation privilege.
Ordinary viewer/provider credentials and forwarded email metadata cannot authorize management.
The external integration authenticates its administrators; no new UI, browser key exposure or ownership challenge is added here.

## State, failure and recovery

Mutations lock the relevant site row exclusively and commit safe attribution with state; concurrent registration is constrained uniquely.
Ordinary readers use the coherent current read snapshot; transactional mutation/background/disclosure checks retain the shared lock order.
Disablement committed before the ordinary snapshot denies, while an already-authorized overlapping request may finish; no cross-request stale allow cache is permitted.
Correct mistaken identity through a new pair plus disablement, never an edit transferring private owners/connections.
Re-enable restores eligibility only, not expired sessions or missing shared membership.
Personal access follows verified owner equality across configured apps; shared audiences explicitly name sites/users and are not expanded by enrollment.
Disablement blocks new site-bound starts/checkouts/disclosure without cancelling already-dispatched work or deleting retained results.
Failure to persist is failure, not a successful administrative response.

## Verification and extension

Use [V01/V02/V08](../../../verification.md) and the scenarios in this slice with real Postgres and actual supported Cloud/Server adapters.
The historical separate Cloud login/site-ID result is partial; it proves neither restoration nor Server support, and viewer equality is unnecessary.
Begin with an empty registry and controlled operator seeding through the same narrow authority.
Rollback stops affected admission/management rather than inventing allow-all fallback or a custom restore subsystem.
New deployments extend the supported identity adapter/configuration contract without a new enrollment product.
