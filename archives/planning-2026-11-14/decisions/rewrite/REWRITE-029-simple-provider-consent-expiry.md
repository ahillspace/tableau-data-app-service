# REWRITE-029: Restart expired provider connection attempts

Status: accepted by the user during the final review walkthrough.
Recorded: 2026-11-09.
Current scope: [REWRITE-042](REWRITE-042-no-separate-service-signout.md) removes separate end-user service logout and its app-versus-global scope decision; expiration, revocation, correct-account handling and other accepted behavior remain required.

## Decision

Do not build dedicated recovery that preserves unfinished provider consent while the user signs into the service again.
Keep the ordinary bounded, single-use authorization transaction and its initiating owner/app/browser binding.
Normal access-token renewal within the same valid persistent service session does not cancel an otherwise valid attempt.
If the service session truly expires, is revoked or logged out, or the authorization attempt expires, terminate the attempt and require a new explicit connection attempt under valid authority.

Do not pause callback completion awaiting a new login, stage exchanged credentials for later consent recovery, replay a consumed code, or revive a terminal attempt.
An interrupted or rejected replacement leaves the previously committed provider connection unchanged; this does not override an independent disconnect or revocation.
Recheck current authority before callback exchange and credential publication through existing transaction rules.
An uncommitted remote authorization grant is not guaranteed to be revoked by local cancellation.

## Scope and rationale

This removes the proposed same-owner revalidation/resume branch for consent outlasting the service session.
It does not remove standard transaction expiry, secure persistent sessions under REWRITE-027, or normal credential renewal.
The exact authorization-attempt lifetime remains an implementation choice; the previously proposed fifteen-minute value is not adopted here.
If real provider testing shows frequent failed connection attempts from this boundary, reassess using that evidence rather than adding recovery machinery in advance.

## Verification

Verify ordinary session/access renewal preserves the bound attempt, while true session expiry, logout/revocation and transaction expiry prevent late attachment.
Verify a fresh login cannot revive a failed attempt and the user can explicitly begin a new one.
Race authority loss against callback exchange and commit; neither a stale callback nor a staged response can overwrite the last valid connection.
These are required future tests, not implemented or verified behavior.
