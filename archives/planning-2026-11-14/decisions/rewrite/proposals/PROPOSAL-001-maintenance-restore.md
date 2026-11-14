# PROPOSAL-001: Restore during controlled maintenance

Status: new architecture recommendation for user review, not an accepted decision or implemented recovery procedure.
Recorded: 2026-11-08.
Scope: X01 and the restore consequences of REWRITE-001, REWRITE-003, REWRITE-005, REWRITE-008, REWRITE-011, and REWRITE-012.

## Recommendation and why

Replace the universal external recovery generation with an explicit maintenance restore procedure.
Stop all service processes, restore into an isolated database, reset short-lived authority and delivery state, and reopen only the connections and policies whose current validity has been established.
Do not carry a recovery-generation field through every connection, session, job, callback, and provider cursor.
One internal service can accept downtime and deliberate recovery work; a platform-wide history protocol adds implementation obligations to every ordinary request.

This simplification moves responsibility into a real operational procedure.
A backup can contain a credential disconnected after the backup, an old rotating refresh token, an old backend grant, or a queued job that actually completed before the failure.
Successful decryption, a fresh Tableau login, or an operator acknowledging a warning establishes none of those missing facts.
The service cannot detect an unannounced rollback solely by inspecting an internally consistent restored database.

## Recommended procedure

1. Put the front door in maintenance mode, stop admission and ingress, drain bounded in-flight requests, and stop every API, worker, scheduler, and maintenance process.
   Disable automatic restarts and prevent the old process population from reaching the restored database.
   A stalled process must be terminated or its database/network access fenced before continuing.
2. Preserve any surviving newer database/WAL evidence and identify the backup time and potential lost interval.
   Restore into isolation and verify database integrity and required decryption keys without exposing private HTTP routes.
3. Discard browser sessions, pending Tableau/provider authorization transactions, exchange handoffs, and derived credential caches.
   Disable restored backend API credentials until reconciled with the current independent secret/configuration source; rotate them if revocation history is incomplete.
   Previously issued browser tokens and callback state then fail ordinary lookup, without a universal generation field.
4. Reapply current app enablement, viewer grants, provider destinations, service bindings, backend grants, and webhook subscriptions from the team's authoritative versioned configuration.
   Restored policy rows alone are not current authority.
   A connection-specific disconnect or permission revocation may not be represented in that configuration and requires the separate credential disposition below.
5. Stop restored nonterminal jobs and pending webhook deliveries from becoming eligible for automatic execution.
   Classify restored jobs as interrupted by restore, retaining any external task ID and existing result only as protected historical evidence.
   Review known external tasks individually before resuming observation; never replay their submission as recovery.
   Do not replay the restored webhook backlog automatically.
6. Create a fresh event replay namespace and discard old replay cursors and delivery attempts.
   This is one event-specific history marker, stored in the database and explicitly replaced by the restore procedure, not a new authority generation used throughout the application.
   Notify configured consumers of the replay reset through an authorized control event and require authoritative resynchronization where available.
7. Apply and record each connection's disposition, validate current configuration, then reopen with fresh sessions and explicitly enabled integrations.
   Keep unresolved integrations disabled while independent, verified integrations resume.

## Credential disposition

| Available evidence | Recommended action | Why |
| --- | --- | --- |
| Independent current authority records and authoritative provider evidence prove the exact restored credential is usable, including any refresh rotation. | Permit explicit operator-approved reuse of that connection and revision. | The evidence closes both the local revocation and remote credential gaps. |
| Current local authority is known, but a refresh token may have rotated in the lost interval. | Reconnect, or use a documented non-destructive provider reconciliation mechanism. | A trial refresh can itself be unsafe; a successful access-token request does not validate its refresh token. |
| Local disconnect, account replacement, or grant history is incomplete. | Retire the affected old connection and establish a new delegated authorization or service credential. | Provider acceptance cannot prove that our service still has permission to use it. |
| Static service secret is available from an independently current secret source and its current app grant is known. | Reprovision it through the operator path, normally as a new connection when old local authority is uncertain. | This avoids treating an old active database flag as permission. |
| Evidence remains incomplete. | Leave the affected connection and its private historical disclosures unavailable. | A signoff cannot make unknown authority current. |

The ordinary recovery path should assume the team does not maintain a complete independent ledger of every delegated revocation and token rotation.
Consequently, reconnecting affected delegated accounts will often be the simplest honest action.
Reuse is an exception supported by evidence, not an automatic provider health check.
An old connection retired because its authority is uncertain does not regain access to its old jobs or events merely because the same person creates a new connection.
Any historical export is a separate operator-authorized action under current policy.

## Lost job history and client behavior

Retained job records still suppress duplicate submissions under REWRITE-008.
A job record lost after the backup cannot suppress a repeated submission, even when the caller retains the original submission ID.
No replacement tombstone store or signed admission window is proposed.

After session loss, restore notification, or an unknown job lookup, the SDK performs inspection and presents missing history; it does not recreate old work automatically.
An authorized backend must follow the same rule after restore or credential rotation.
A deliberately new submission can repeat a remote effect, and this limit remains part of the API contract.
Lost external task IDs and effects require provider/application investigation or an explicit unresolved disposition; the restore process cannot manufacture them.

## Costs and simpler alternatives

Doing nothing beyond restoring the database is shorter but can revive revoked authority and repeat work.
Unconditionally deleting all provider credentials is operationally simpler and remains a valid fallback when evidence is unavailable, at the cost of reconnecting every integration.
The recommendation permits evidence-based recovery of unaffected integrations without building a universal online recovery system.
It does not provide transparent recovery, a guaranteed recovery duration, or protection against an operator bypassing the procedure.

## Specification implications and completion evidence

Replace the baseline restore-generation sections in architecture, contracts, access, persistence, HTTP/SDK, and verification during the eventual rewrite.
Remove generation-tagged receipt IDs, universal provider-cursor invalidation, and command-window recovery claims.
Keep normal ownership, connection epochs, refresh fencing, finite job deduplication, and event-specific replay reset behavior.

A representative drill must restore before a disconnect, token rotation, completed job, backend-key revocation, and acknowledged event position.
Demonstrate that old tokens/callbacks fail, unknown credentials remain unusable, pending work does not restart, old event positions force resync, and a missing job is not treated as proof of no effect.
Then reopen one independently verified service integration while an uncertain delegated connection remains unavailable.
Hosting controls, backup/WAL policy, the team's authoritative configuration location, and a successful drill remain real operational dependencies.
