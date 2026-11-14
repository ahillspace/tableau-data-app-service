# REWRITE-013: Standard database persistence and accepted backup loss

Status: accepted by the user for the architecture rewrite.
Recorded: 2026-11-08.
Audit topic: X01, previously an unestablished reference comparison.

## Decision

Use ordinary persistent Postgres storage and standard database restart behavior.
If restoring an older backup is necessary, accept loss of the changes since that backup.
Do not build application-specific backup-restore handling or require a restore runbook for this project.
Remove the universal recovery-generation protocol, restore quarantine, mandatory mass reconnection, and restore-specific history gates from the proposed architecture.
Do not adopt PROPOSAL-001's custom maintenance restore procedure.

## Rationale

The user explicitly accepts the lost interval after restoring a backup and does not want special recovery machinery.
This internal platform does not require application-level guarantees across a rollback of database history.
Ordinary restart durability is distinct from intentionally restoring older state.

## Consequences and limits

Restoring an older backup can restore older connection, permission, session, job, and event records and discard newer changes.
Provider actions already performed are not undone by a database rollback.
Submission duplicate protection cannot cover job records that the restore discarded.
Do not promise recovery of lost changes, preservation of post-backup revocations, or automatic reconciliation with external providers.
These are accepted restore limitations, not reasons to reintroduce special recovery handling.

## Relationship to earlier records and proposals

This supersedes the baseline external recovery-generation and disruptive restore requirements.
It rejects the restore-specific machinery in PROPOSAL-001; that proposal remains historical and unaccepted.
Earlier verification examples concerning restore must be reconciled with this accepted limitation, rather than treated as requirements for custom recovery logic.
Normal authorization checks, credential refresh coordination, job submission deduplication within retained history, encryption, and retries-off defaults remain unchanged.
REWRITE-012's explicitly accepted maintenance-window encryption-key replacement and key availability requirements remain in scope; this decision concerns database backup restoration.
Do not add automatic replay of interrupted handlers as an implication of accepting backup data loss.

## Required rewrite consequences

Remove restore generations, generation-tagged locators, quarantine workflows, and special restore acceptance gates from architecture, contracts, access, persistence, SDK, and verification.
State the accepted backup-loss boundary concisely in operational limitations.
Use standard database persistence without designing an application recovery subsystem or a project restore runbook.

## Verification boundary

This records accepted product scope and loss tolerance.
It does not establish that backups, hosting recovery, encryption-key custody, or database durability have been configured or tested.
