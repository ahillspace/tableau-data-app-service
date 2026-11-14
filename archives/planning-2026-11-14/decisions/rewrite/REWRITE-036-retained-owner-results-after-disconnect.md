# REWRITE-036: Retained owner results remain readable after provider disconnect

Status: explicitly accepted by the user.
Recorded: 2026-11-10.

## Decision

An owner may read their own retained job and saved result in the Data App after disconnecting the provider connection used by that job.
The caller must still have current valid service-session, app/site and ownership authorization.
The configured result and metadata retention periods still apply; disconnect does not automatically delete retained results or metadata.
A local historical read does not use provider credentials, reconnect the provider, authorize new provider work or recover an expired result body.
Provider access through the disconnected connection remains blocked, and connection replacement cannot retarget accepted work or expose another owner's data.

## Integration

D05's owner-history product choice is settled; current-authority enforcement and the read/notification/cancellation boundaries remain engineering responsibilities under existing contracts.
REWRITE-034 already removed external application-server consumers and delegated-backend policy.
Do not reintroduce backend grant continuity or approval screens through historical result access.

## Verification boundary

Verify a completed job, provider disconnect, an authorized read before result expiry, result-expired behavior afterward, and denial after app/site/session/ownership authority is lost.
This is accepted policy and documentation guidance, not a runtime test result.
