# REWRITE-020: Jobs outlive browser sessions; revocation blocks new work

Status: accepted by the user for the architecture rewrite.
Recorded: 2026-11-08.

## Decision

Accepted jobs may continue after the browser closes or its backend session expires.
Require fresh valid authorization to inspect private job status and results after session expiry.
Do not build special machinery to cancel active jobs when a provider connection is revoked.
Revocation blocks new job submissions and new starts using that connection.
Queued work must still have a usable authorized connection before starting; an active job is work that has already started.

## Rationale

Long-running jobs should not depend on a viewer keeping a browser session open.
The user explicitly accepts active work continuing after revocation and does not want a cancellation system to enforce otherwise.
The meaningful revocation boundary is preventing new work rather than promising remote interruption.

## Consequences and limits

An active job may complete after revocation.
If the external provider invalidates credentials, remaining calls can fail naturally; do not promise the job can continue despite remote revocation.
Do not retain or resurrect revoked credentials, switch accounts, or bypass provider rejection to make an active job finish.
Already-submitted external tasks may continue under the provider's own lifecycle.
This does not require automatic remote cancel calls, an active-job revocation broadcast, or waiting for every active job before committing revocation.
Private results remain subject to current disclosure authority; continuation is not permission to expose results to an unauthorized caller.

## Relationship to prior decisions and proposals

REWRITE-019 retains the worker execution model and REWRITE-007/016 retain author-controlled retry policy.
Replace PROPOSAL-004's recommendation to terminate tracking or stop active work solely because connection authority changes with this accepted boundary.
Keep ordinary disconnect state and credential-update fencing under REWRITE-005; a late refresh cannot reactivate a disconnected connection.
No general job-cancellation feature or provider-cancel contract is selected by this record.

## Details still to resolve

Specify the atomic admission/start authorization checks and races with revocation without promising an instantaneous external cutoff.
Reconcile active-job helper access with revoked credential storage and natural provider errors, without adding mandatory active cancellation.
Browser-owned and Tableau-owned sessions follow the same job lifetime rule, subject to the selected ownership mechanism.

## Required rewrite consequences

Separate browser session lifetime from job execution authority and result disclosure.
Define revocation as preventing new submissions/starts, and remove mandatory active-job cancellation or tracking-termination machinery triggered by revocation.
Document that active provider work may continue or fail according to provider behavior.

## Verification boundary

This records accepted lifecycle behavior, not tested revocation or job execution.
