# Persistence and operational boundaries

Status: proposed ownership and invariants, not a migration or deployment plan.
Use one Postgres database with Kysely adapters behind owner-specific interfaces.
Table names below are conceptual and may follow project conventions during implementation.

| Record family | Owner | Required invariant |
| --- | --- | --- |
| Apps and capability bindings | Access | Revision-checked updates; an enabled binding references a registered compatible capability and provider configuration. |
| Provider registrations | Connections | Validated configuration revision; secret references never embedded in public configuration. |
| Connections | Connections | Stable owner and provider association; monotonic authorization epoch; disconnected is terminal. |
| Credential secrets | Credentials | Encrypted authenticated envelope bound to connection and revision; at most one active current revision. |
| Authorization transactions | Connections | Unique state digest, one claimed exchange, expiry and initiating authority binding. |
| Renewal attempts | Credentials | At most one active claim for a connection/revision; durable dispatch evidence; conditional result commit. |
| Invocation receipts | Execution | Unique app/owner/request-key digest; immutable command digest and resolved identity; monotonic effect evidence. |
| Event receipts and feed rows | Events | Unique source-event deduplication key; audience routing and feed insertion in the same commit. |
| Feed counters | Events | Committed order per app through a transaction-held row lock. |

Each owner writes its records through explicit commands and conditional updates.
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
Validate relationships: output retention cannot exceed command retention, and event deduplication retention must cover the supported provider replay horizon.
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

Backups and restores need an explicit operational procedure before production use.
Restoring older credential revisions can replay invalidated refresh tokens, and restoring older receipts can lose duplicate-suppression history.
The safe initial restore posture disables outbound execution until the operator reconciles or reauthorizes affected connections and establishes a new command-retention boundary.
This design does not claim transparent recovery across an arbitrarily stale database restore.
Key rotation requires a tested re-encryption process with overlapping read keys and conditional writes; a key ID field alone is not implementation proof.

The extension path for new persistent state requires a concrete domain invariant and its owner.
Adding an ordinary capability or provider using existing lifecycle behavior requires configuration and code registration, not another database or generic metadata table.
