# PROPOSAL-007: Credential safety and a small operational boundary

Status: new architecture recommendation for user review, completing REWRITE-005 and REWRITE-012 and their deployment implications.
Recorded: 2026-11-08.

## Recommendation and why

Keep credential refresh coordination in Postgres and perform encryption-key replacement with all application processes stopped.
Run one API process and one worker initially, using the same application build and database.
Add replicas only for an observed need; the database claims and event fanout already define the cross-process boundaries.
This fits the accepted durability and downtime choices without a broker, workflow engine, distributed key-management service, or extra data store.

## Refresh mechanism retained under D05

Use one active refresh-attempt row per connection and credential revision, with claim token, starting authorization epoch/revision, expiry, and `prepared` or `dispatched` phase.
Claim in a short transaction, reread the latest credential before deciding renewal is still needed, and commit `dispatched` before making the provider renewal request.
Waiters reread or wait within their own request deadline; they do not issue a second renewal for that revision.
Commit a validated replacement only if the claim, epoch, revision, and current connection state still match.
An omitted replacement refresh token follows that provider's documented semantics rather than automatically deleting the existing one.

An abandoned `prepared` attempt may be safely claimed again because the core forbids sending before the dispatch commit.
An abandoned `dispatched` attempt is uncertain even if the process might have died before sending.
Use only provider-documented safe retry/reconciliation to recover; otherwise require reconnection.
Disconnect and account replacement invalidate claims and advance the epoch before accepting any delayed response.
Do not turn a renewal error into an automatic retry of the original proxy/business request.
These stricter credential rules are retained acceptance, distinct from the simplified capability error contract.

## Encryption and key replacement

Recommend AES-256-GCM through Node's established `node:crypto` API, using a fresh cryptographic 96-bit random nonce per encryption and a full 128-bit authentication tag.
Use a versioned envelope with key ID, nonce, ciphertext, and tag; authenticate the record purpose, immutable record identity, provider/connection association where applicable, and logical secret revision as additional data.
Node documents authenticated modes, authentication tags, and additional authenticated data in its [crypto API](https://nodejs.org/api/crypto.html).
Keep this small envelope implementation independently reviewed and test corruption, wrong-context substitution, and incorrect-key rejection.

Encrypt provider credentials, pending exchanged credentials/verifiers, and persisted private job input/results/event payloads that the existing confidentiality contract requires protecting.
Store digests rather than reversible ciphertext for random bearer credentials used only for verification.
Keep provider client secrets, encryption keys, and webhook signing secrets in protected hosting secret storage or encrypted records as their operational use requires; never ordinary configuration committed to source control.
Encryption keys remain outside the database and its backups, with separately protected recovery copies.

For this initially small service, recommend one offline database transaction for re-encrypting all affected rows and updating a migration-completion marker.
Stream rows through bounded memory, authenticate old envelopes, encrypt with the new key, verify new envelopes, and commit only after the full pass succeeds.
There are no concurrent writers and no ordinary requests during the operation.
Estimate row/byte volume and maintenance duration first; refuse the procedure if one transaction is operationally unsuitable rather than silently switching to an untested partial migration.
That future case would justify a specific resumable batch design, not an online rotation subsystem now.

Before rotation, stop all API/worker/callback/ingress/maintenance paths and disable restarts; drain or terminate active credential users.
If an already-dispatched refresh has an unknown outcome, retain its uncertainty rather than relabeling it safe because maintenance began.
Only the migration process receives both old and new keys.
An interruption before commit rolls back database changes; an interruption after commit leaves a completed marker and new-key envelopes, so resume forward with the new key rather than re-encrypting blindly.
Update the protected runtime key reference, verify every covered envelope and marker, then reopen.
Missing/incorrect keys or a marker/configuration mismatch keep the application unavailable.
Retain old keys in protected recovery custody until every retained backup requiring them has expired or been explicitly retired.
Restoring an older backup follows PROPOSAL-001; it is not a casual rotation rollback.

## Deployment and operating contract

Use TLS at a controlled front door, explicit trusted-proxy settings, bounded requests, and streaming-compatible buffering/timeouts.
Provide separate liveness and readiness checks; readiness fails when required database/schema/key/configuration state is unavailable.
The API owns HTTP, callbacks, provider ingress, and SSE; the worker owns managed jobs, external-task checks, webhook attempts, and bounded cleanup.
Use claimed housekeeping within that worker rather than a separate scheduler service.
Provider modules and both processes use the same versioned release and shared credential/policy code.

Prefer maintenance deployment for schema or credential-breaking changes; do not promise mixed-version rolling upgrades initially.
Keep operator configuration reviewed and versioned outside database backup history, with secret references rather than secret values.
A narrow administrative command surface can validate/apply configuration and inspect failures; an admin dashboard is not required.
Record safe app/principal/connection/job/event IDs and outcomes, queue age, expired claims, uncertain refreshes, failed deliveries, and cleanup failure without provider bodies or secrets.
Capacity limits and retention apply across the shared deployment, not separately per API replica.

The operator chooses hosting, secret custody, backups/PITR, recovery targets, and network policy before deployment.
No high-availability or numeric recovery promise follows from these documents.
The service's reviewable extension paths are another API/worker replica, a documented provider hook, or a larger maintenance migration only when evidence requires them.

## Costs, alternatives, specification implications, and evidence

A single transaction makes interrupted rotation easy to reason about but lengthens downtime as retained encrypted data grows.
An established encryption primitive avoids inventing cryptography; a managed key service may later be appropriate if the chosen host already provides it.
Do not add a key-management dependency solely to avoid a maintenance window the user accepts.

Rewrite persistence/access/contracts and operational verification around the refresh attempt, versioned envelope, stopped-process rotation, and two-process topology.
Test concurrent refresh, disconnect/replacement races, lost rotating-token responses, correct/wrong key handling, context substitution, interruptions on both sides of the migration commit, and restoring an older-key backup.
Exercise two workers claiming jobs and delivery attempts without duplicate active claims, plus API/worker shutdown with in-flight work.
A successful drill and hosting-specific controls are completion evidence; source review alone is not supported rotation or recovery.
