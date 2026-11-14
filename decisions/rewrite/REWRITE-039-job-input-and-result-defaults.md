# REWRITE-039: 100 MB managed-job input and result defaults

Status: explicitly accepted by the user.
Recorded: 2026-11-10.
Duration follow-up: [REWRITE-041](REWRITE-041-job-execution-cap.md) subsequently locks the environment-configured 24-hour cap from first execution start, with optional lower capability limits and omission inheriting the cap.
Payload-policy supersession: [REWRITE-040](REWRITE-040-single-job-payload-caps.md) replaces separate payload defaults/ceilings with one configurable server cap each, optional lower capability limits and omission inheriting the cap; duration remains separate.

## Decision

The default maximum submitted managed-job input is 100 MB, and the default maximum stored job result is 100 MB.
Use decimal megabytes: each default is 100,000,000 bytes, not 100 MiB.
These are configurable service defaults, with optional capability overrides within configured server bounds under REWRITE-038.
Omitted overrides inherit the corresponding default.
The values apply to submitted job payloads and stored results, not ordinary proxy requests, uploads, downloads or every byte a capability processes internally.

This acceptance supersedes the proposed 1 MiB input / 10 MiB result pair and earlier 256 KiB input / 1 MiB result drafts.
It does not select a numeric duration default; the 24-hour deadline proposal remains under discussion.
No unlimited duration or unlimited payload mode is accepted.

## Engineering and verification

Make serialized-payload byte accounting explicit and consistent across HTTP validation, admission, stored input/result handling and documented configuration.
Account for serialization and encryption/storage overhead separately rather than silently shrinking the accepted application payload allowance.
Enforce effective limits without unbounded simultaneous buffers, accidental full-payload logging or exposing private input/result data.
Validate ingress/parser configuration, memory use, encryption and database behavior with representative payloads near 100 MB and concurrent work.
Verify both boundary acceptance and oversized rejection, service-default configuration, optional override fallback and retention cleanup.
Large-input admission and deduplication still obey the existing short-transaction and atomic-admission rules.
These checks verify the selected limits; they do not reopen them or claim measured capacity before runtime evidence exists.
No implementation, infrastructure installation or deployment is authorized by this decision.
