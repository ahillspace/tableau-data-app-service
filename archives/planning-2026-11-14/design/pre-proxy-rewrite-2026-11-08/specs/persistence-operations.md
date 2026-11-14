# Persistence and operational boundaries

Status: proposed ownership and invariants, not a migration or deployment plan.
Use one Postgres database with Kysely adapters behind owner-specific interfaces.
Table names below are conceptual and may follow project conventions during implementation.

| Record family | Owner | Required invariant |
| --- | --- | --- |
| Apps and capability bindings | Access | Revision-checked updates; an enabled binding references a registered compatible capability and provider configuration. |
| Event subscriptions and source associations | Access and Events | Operator-approved versioned audience/resync policy; verified source mapping cannot be nominated by payload data. |
| Provider registrations | Connections | Validated configuration revision; secret references never embedded in public configuration. |
| Connections | Connections | Stable owner and provider association; monotonic authorization epoch; disconnected is terminal. |
| Credential secrets | Credentials | Encrypted authenticated envelope bound to connection and revision; at most one active current revision. |
| Authorization transactions | Connections | Unique state digest, one claimed exchange, expiry and initiating authority binding. |
| Renewal attempts | Credentials | At most one active claim for a connection/revision; durable dispatch evidence; conditional result commit. |
| Invocation receipts | Execution | Unique generation/app/owner/request-key digest; immutable command digest, window and resolved identity; monotonic effect evidence. |
| Event receipts and feed rows | Events | Unique source-event deduplication key; audience routing and feed insertion in the same commit. |
| Feed counters | Events | Committed order per app through a transaction-held row lock. |

Each owner writes its records through explicit commands and conditional updates.
Connections, authorization transactions, operation records and event history carry the recovery generation under which they were created.
Configuration is reviewed for the active generation during recovery; restored records are not silently relabeled as current.
Foreign keys and unique constraints enforce identity and deduplication invariants even when application requests race.
Cross-owner transactions are narrowly named operations such as commit-authorization and accept-event, not general unit-of-work plumbing available to every handler.
No provider module queries or updates these tables directly.

Authorization completion atomically checks the current app revision/enablement and expected connection epoch before publishing usable credentials.
Disconnect atomically changes the connection epoch/state and invalidates outstanding replacements and renewal claims.
Invocation admission checks configuration and resolved authority in the receipt transaction; per-request dispatch checks current policy again.
Network requests always occur outside transactions.
Long provider latency therefore cannot retain database row locks.

Stored result bodies, credential material and any required external identity are protected according to sensitivity and retention.
Raw invocation inputs are not persisted by default; use a keyed digest of canonical validated commands for duplicate detection.
Safe operation records contain app ID, capability/version, opaque internal connection reference, identity kind, time, duration, outcome, error category and request counts.
Holder/binding references are protected internal pseudonyms and omitted from ordinary logs where unnecessary.
Never log tokens, secret headers, callback codes/state, authorization URLs, raw provider errors, request/response bodies or external account identifiers.
Logging uses allowlisted fields rather than relying only on a secret-name denylist.

Required operational configuration includes body/request limits, provider deadlines, renewal waiting limit, authorization expiry, feed retention, event deduplication retention, output retention, command-tombstone retention and per-app capacity.
Validate relationships: issued command windows cover their admission interval, maximum execution deadline and normal output-retention interval, and event deduplication retention covers the supported provider replay horizon.
Already issued windows retain their promised duplicate-suppression interval when configuration changes.
Signing-key rotation preserves verification of issued command windows through their supported history interval.
If a provider's replay or idempotency horizon is unknown, declare the resulting guarantee limited instead of choosing a reassuring number.
Limits are finite and bounded by service-wide maxima; a provider module cannot increase them arbitrarily.

A bounded maintenance pass in the same application expires abandoned transactions, classifies stale supervised operations, removes expired retained data and reports cleanup failures.
Maintenance is idempotent and claimed through Postgres if more than one process is ever used.
It does not reexecute capabilities or replay unsafe token renewals.
The same transitions may run lazily on reads so correctness does not depend on a timer firing precisely.
An external queue or scheduler is not required for this housekeeping.

Database or encryption-key unavailability prevents new work requiring durable guarantees.
A provider write is never dispatched before its receipt/dispatch marker is durably stored.
If the provider succeeds but final persistence fails, the old marker preserves an uncertain outcome and duplicate submissions cannot start a second handler.
Known results may be retained in memory while bounded persistence recovery is attempted, but uncommitted results are not advertised as durable replay state.

## Restore barrier and history generations

The service reads a small operator-controlled recovery record containing an opaque generation and an open/closed gate from protected configuration outside the database backup/restore boundary.
This does not require another database or online identity service.
The selected configuration mechanism and production runbook remain operational decisions, but the gate and generation comparisons are mandatory domain invariants.
An unavailable recovery record or a mismatch with the database's initialized-generation marker keeps the service closed.

Before restoring, stop active processes and close the gate so no private reads, command admissions, authorization launches/completions, provider event admissions or outbound requests can run against restored state.
Advance the external generation before reopening any process against the restored database.
All old access bindings, command windows, pending authorization transactions, request/result references and pagination/feed cursors then belong to discarded history.
Old credential records are quarantined and cannot authorize dispatch or connection-based disclosure, regardless of the restored active flag.
Operator diagnostics may inspect protected historical records under a separate recovery context; browser routes cannot.

Reopening requires operator confirmation that current app policy and event source associations have been reviewed, old credentials remain unusable, the trusted boundary issues only the new generation, and the write gap between the backup and failure has an explicit disposition.
Lost command records cannot prove that writes in that gap did not occur.
An unresolved write requires provider/application reconciliation or a recorded decision to leave that operation unresolved; it is not automatically replayed.
Affected delegated accounts authorize new connections and service credentials are explicitly reprovisioned into the new generation.
No recovery action changes an old command's window or silently reactivates its old connection ID.
The initialization marker is committed only after those conditions hold, then the external gate can open.

At every private read, authorization completion, command admission and dispatch, require active-generation equality as well as ordinary current authority.
An old access binding returns access-expired and must be renewed through the selected trusted boundary.
Under new valid access, an old command window or receipt reference returns history-expired without private data, and an old feed cursor returns resync-required.
An old provider-page cursor returns cursor-expired so the read restarts.
Public opaque receipt IDs carry an authenticated generation tag, permitting expired-history classification even when their database row was lost.
These history tags are locators, not resource authority, and contain no account or credential data.

The new feed may restart its counters because every cursor binds the new generation; a retained cursor at old position 100 cannot skip newly accepted positions 91-100.
Clients establish a new feed head, reread authoritative state and consume subsequent invalidations.
Provider notification replays across the restore boundary are not promised duplicate-free; the new history and resync contract are explicit.
Old command-window tokens are rejected before new admission even if the old write's tombstone was lost.
Issuing a fresh window authorizes only a new intentional command under current policy, not automatic recovery of the old write.

This is a deliberately disruptive recovery posture, not transparent restore or an exactly-once external effect guarantee.
The service cannot detect an operator bypassing the restore procedure merely from a stale database that appears internally consistent.
Key rotation requires a tested re-encryption process with overlapping read keys and conditional writes; a key ID field alone is not implementation proof.

The extension path for new persistent state requires a concrete domain invariant and its owner.
Adding an ordinary capability or provider using existing lifecycle behavior requires configuration and code registration, not another database or generic metadata table.
