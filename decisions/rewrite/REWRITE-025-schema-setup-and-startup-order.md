# REWRITE-025: Ordinary schema setup and process startup ordering

Status: accepted by the user for the next specification revision.
Recorded: 2026-11-08.
Coverage finding: OT-01.

## Decision

Use ordinary existing database migration tooling to create required tables on installation and apply versioned schema changes on software upgrades.
Assign one migration owner and ensure the required schema is ready before API requests or worker job claims use it.
Migrations mean changes to database tables, columns, or indexes, not moving to another database or restoring a backup.
Keep startup and ordinary shutdown ordering small and appropriate to one API and one worker from the same codebase.

## Rationale and boundaries

A new installation must create the tables before application code can use them.
An upgrade must not expose an incompatible API/worker/schema combination as ready.
Stop new admission and job claims before closing required dependencies, using the existing interrupted-job and credential-renewal rules for in-flight work.
Do not build a migration platform, deployment orchestrator, rolling-upgrade/HA system, or new recovery framework.
The migration tool, commands, concrete host readiness hooks, and release mechanism remain implementation choices.

## Relationships

This accepts ordinary installation and upgrade ownership only, not all mechanisms or defaults in the earlier unaccepted operations proposal.
REWRITE-013 still rejects application-specific backup restore machinery and accepts loss of changes after an older backup.
REWRITE-012's maintenance-window encryption-key replacement remains a separate accepted operation.
REWRITE-019 retains one codebase with API and worker processes.

## Required specification changes

Document minimal schema setup/upgrade ownership and API/worker startup/readiness/shutdown ordering in operations and verification.
Use clean-install and failed-schema/setup checks without claiming these procedures are implemented or tested.
Integrate this accepted record in the next explicit revision, keeping previous audit provenance intact.

## Verification boundary

No migrations, installation, release, schema upgrade, or process shutdown journey has been implemented or tested.
