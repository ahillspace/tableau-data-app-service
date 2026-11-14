# REWRITE-041: 24-hour execution cap from first start

Status: explicitly accepted by the user.
Recorded: 2026-11-10.

## Decision

Use one server execution-duration cap, currently 24 hours, configured through an environment variable and validated before readiness.
Exact environment-variable names remain engineering choices.
A trusted registered capability may optionally set a lower duration; omission uses the server cap, with no separate default beneath a ceiling and no per-request caller override.
The cap is an absolute elapsed duration beginning at the job's first execution start, not its submission or initial queue admission.
Time waiting for an external provider task, and any author-enabled retry delay after first start, counts toward that same duration.
Progress, credential refresh, observation and later retries do not reset or extend the deadline.

The cap accommodates legitimate long-running external tasks; normal work returns immediately when complete and known short operations can declare lower limits.
External waiting releases worker execution capacity, and a separate worker-liveness lease detects interruption before a healthy job's execution cap expires.
The duration does not require a browser to remain online or renew interactive authority.

## Persistence and expiry

Resolve and retain the effective duration at admission, then atomically record the first execution start and absolute deadline with the first worker transition to running using server/database time.
Later configuration changes do not rewrite the admitted duration or an established deadline.
Initial queue waiting has no execution deadline yet; accepted explicit cancellation and current-authority checks still apply before start.
Deadline handling ends local execution/tracking with an honest timeout result, subject to existing claim/revision and terminal-race rules.
A timeout does not prove a remote task stopped or rolled back, and this decision adds no automatic remote-cancellation machinery.

## Supersession and verification

Supersede REWRITE-038's duration default/ceiling model and the earlier admission-based absolute deadline proposal.
REWRITE-039/040 statements that numeric duration remained open describe their earlier acceptance; this record settles it.
REWRITE-040's 100 MB input and stored-result caps remain separate and unchanged.
No numeric managed-job limit choice remains open after this acceptance.

Verify environment configuration before readiness, cap inheritance, lower capability limits, rejected above-cap/caller overrides and deadline creation at first start after queue waiting.
Verify elapsed external waiting/retries, no deadline reset on progress/refresh/observation, separate lost-worker supervision and timeout/callback/cancellation races without remote rollback claims.
This is accepted design, not implementation or runtime verification, and does not authorize implementation, installation or deployment.
