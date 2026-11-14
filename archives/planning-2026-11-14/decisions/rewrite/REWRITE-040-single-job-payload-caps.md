# REWRITE-040: One server cap for each managed-job payload

Status: explicitly accepted by the user.
Recorded: 2026-11-10.
Duration follow-up: [REWRITE-041](REWRITE-041-job-execution-cap.md) subsequently locks the environment-configured 24-hour cap from first execution start, with optional lower capability limits and omission inheriting the cap.

## Decision

Use one configurable server cap for submitted managed-job input and one for the stored result.
Each cap is currently 100 MB (100,000,000 bytes), preserving the numbers selected in REWRITE-039.
There is no separate default value beneath another hard ceiling.
A trusted registered capability may optionally set a lower input or result limit; omission uses the corresponding server cap.
Capability configuration cannot increase the server cap, and individual caller requests cannot override these limits.

These caps apply to submitted/stored job payloads, not ordinary proxy uploads, downloads or every byte a capability processes internally.
File content embedded in a submitted/stored payload counts toward its cap.
A file reference counts as its serialized reference rather than the full contents of the referenced file.
The accepted 5 GB streamed-response setting remains separate; neither a 5 GB upload cap nor a 250 MB stored-result cap was accepted.

## Configuration and scope

Configure both server caps through environment variables, as explicitly accepted by the user.
Validate their values before readiness; exact names remain engineering choices rather than user-selected contracts.
Validate configured caps and optional lower capability limits before enabling work, and resolve the effective limits for admission and storage under the existing job contract.
This decision changes byte-size policy only; REWRITE-038 duration configuration remains separate and the 24-hour duration proposal is still unaccepted.
No unbounded duration is accepted by this exchange.

## Supersession and verification

Supersede the payload default-versus-server-ceiling model and upward payload overrides in REWRITE-038/039 while preserving their historical bodies and REWRITE-039's selected numbers.
Retain optional capability configuration, with omission inheriting the cap rather than requiring every author to supply a value.
Verify environment-variable parsing and invalid/missing configuration behavior before readiness, omitted and partly omitted capability settings, lower capability limits, rejection of above-cap configuration and caller overrides, and exact boundary behavior under explicit byte accounting.
Verify embedded files versus references, bounded memory/storage near the selected caps, encryption overhead and separation from ordinary streamed transfers.
Implementation verification establishes actual behavior; it does not reopen the accepted cap model or claim runtime evidence from this record.
This is design reconciliation only, without application implementation, installation or deployment.
