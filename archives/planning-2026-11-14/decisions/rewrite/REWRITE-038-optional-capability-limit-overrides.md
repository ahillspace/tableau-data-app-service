# REWRITE-038: Optional capability limits with service defaults

Status: explicitly accepted by the user.
Recorded: 2026-11-10.
Duration follow-up: [REWRITE-041](REWRITE-041-job-execution-cap.md) subsequently locks the environment-configured 24-hour cap from first execution start, with optional lower capability limits and omission inheriting the cap.
Payload-policy supersession: [REWRITE-040](REWRITE-040-single-job-payload-caps.md) replaces separate payload defaults/ceilings with one configurable server cap each, optional lower capability limits and omission inheriting the cap; duration remains separate.
Follow-up: [REWRITE-039](REWRITE-039-job-input-and-result-defaults.md) subsequently selects input/result defaults; the absence of numbers below describes this earlier acceptance only.

## Decision

Provide configurable service defaults for managed-job duration, input size and result size.
A registered capability may optionally override those values within the configured server limits.
When a capability omits an override, use the corresponding service default.
Do not require each capability author to declare limits merely to use the job interface.

No numeric duration, input-size or result-size value is selected by this acceptance.
The earlier five-minute local, twenty-four-hour external, 256 KiB input and 1 MiB result proposals are not accepted defaults or universal product limits.
Engineering chooses and documents justified service defaults and safety bounds from the intended workload and actual storage/resource behavior.
This does not require another user approval tour for routine tuning constants.

## Enforcement and boundaries

Validate defaults and optional overrides against the service's finite configured bounds before enabling work.
Resolve effective input/result/duration limits before admission; the submitted job records its effective deadline rather than depending on a browser-supplied duration or later default change.
Capability overrides belong to trusted registration/configuration, not arbitrary job-request fields.
A worker liveness lease detects interruption and remains distinct from a healthy job's execution or external-tracking deadline.
The existing interruption, no-implicit-replay, cancellation and provider-task observation rules continue to apply.
The proxy's transfer limit does not become the job input/result limit, and this decision does not add object storage or an unlimited-work mode.

## Verification boundary

Verify fallback when all or some overrides are omitted, validated overrides within configured bounds, rejection of invalid configuration, and unchanged admitted deadlines after default changes.
Test input/result boundary behavior and distinguish healthy long execution from lost-worker supervision.
The policy is accepted; numbers and runtime behavior remain engineering work and unverified evidence.
