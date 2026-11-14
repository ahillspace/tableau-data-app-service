# Accepted decisions 023-025 integration

Status: canonical specification integration prepared on 2026-11-08 for independent review.
This note extends the unchanged [original rewrite traceability](proxy-first-rewrite-traceability.md) with the three later accepted decisions.
It does not alter historical audits/manifests, accept unresolved mechanisms, or establish runtime behavior.

## Traceability

| Accepted record | Canonical treatment | Scope boundary |
| --- | --- | --- |
| [REWRITE-023](../decisions/rewrite/REWRITE-023-connection-runtime-context.md) | [Shared proxy contract](../specs/contracts.md#native-proxy), [connection context](../specs/access-connections.md#connection-runtime-context), [provider registration](../specs/providers-execution.md#provider-registration-and-shared-flows), and [state ownership](../specs/persistence-operations.md#state-ownership) define validated acquisition, protected publication with authorization/credential revisions, and approved destination resolution; [verification](../verification.md#synthetic-fixtures-and-required-journeys) adds two instances, discovery failure, stale writes, and unapproved destinations. | No metadata service, browser base-URL override, registration per account, or required discovery for fixed hosts; exact provider fields/interfaces remain implementation choices. |
| [REWRITE-024](../decisions/rewrite/REWRITE-024-provider-specific-event-lifecycle.md) | [Provider event lifecycle](../specs/providers-execution.md#provider-event-lifecycle), [event ingress](../specs/events-http-sdk.md#optional-event-ingress), [connection context](../specs/access-connections.md#connection-runtime-context), and [live contracts](../specs/contracts.md#live-notifications-and-service-errors) define source ownership, conditional hooks, protected state, and routing retirement; [SDK](../specs/events-http-sdk.md#embedded-browser-sdk-and-backend-client) preserves native API calls and distinct SSE delivery; [verification](../verification.md#cross-module-boundary-checks) covers lifecycle races and browser/source independence. | Manual setup is valid; no universal automatic subscription manager, per-viewer requirement for app-level sources, durable cleanup workflow, archive, replay, or stronger delivery guarantee. |
| [REWRITE-025](../decisions/rewrite/REWRITE-025-schema-setup-and-startup-order.md) | [Schema setup and process ordering](../specs/persistence-operations.md#schema-setup-and-process-ordering) assigns one migration owner, ordinary versioned schema changes, readiness gates, and shutdown ordering; [verification](../verification.md#cross-module-boundary-checks) covers installation, upgrade, failed/incompatible setup, and interrupted shutdown. | No chosen migration tool, command, host hook, release mechanism, rolling-upgrade system, or recovery framework; backup loss and maintenance-window key replacement retain their separate accepted contracts. |

[Goals](../GOALS.md), [PRD](../PRD.md), [architecture](../architecture.md), [choices](../decisions/choices.md), and [README](../README.md) now carry the corresponding requirements and evidence boundaries.
Only REWRITE-023, REWRITE-024, and REWRITE-025 add accepted scope in this integration; earlier proposal packs remain unaccepted except where an accepted record explicitly adopts an individual choice.
No numeric defaults, runtime code, migration implementation, provider implementation, or external architecture names were added to product specifications.

## Evidence boundary

The new [source snapshot](accepted-025-source.json) identifies the integrated source using the existing snapshot script.
The script checks file presence, local file links, and digest equality; it does not validate semantics, external links, or runtime compatibility.
Snapshot generation and verification completed with no link errors and a matching digest across 47 source files.
The digest is `70c1962bd13255b54d93bd7efb63545eaf0034e11cde0970d6d51d76c0854f46`.
Checks of the changed documents' local file/heading links and `git diff --check` passed; pre-existing review, decision, and archived design files retained their pre-integration hashes.
An integration consistency read is distinct from the subsequent independent review and from user acceptance of unresolved mechanisms.

Pending runtime proof includes two-instance context acquisition/routing, discovery failure, sensitive-context protection, stale context/lifecycle rejection, manual and managed source setup, renewal/retirement, live SSE/webhooks, clean installation/upgrade, failed schema/readiness, and ordinary shutdown with interrupted work.
None of those journeys has been implemented or tested, and earlier Tableau/provider/credential/job/operations evidence gaps remain open.
Historical review files and manifests retain their original scope and do not certify this revision.
