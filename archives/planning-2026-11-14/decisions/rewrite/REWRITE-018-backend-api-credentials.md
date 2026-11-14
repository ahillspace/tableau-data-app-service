# REWRITE-018: Separate credentials for participating backends

Current scope: superseded entirely by [REWRITE-034](REWRITE-034-data-app-and-provider-boundary.md); external application-backend consumers and their credentials/grants are removed.
The original decision below is preserved as history.

Status: accepted by the user for the architecture rewrite.
Recorded: 2026-11-08.

## Decision

Give each participating application backend its own server-side API credential.
Associate that backend with the configured apps and connections it may use.
Keep backend API credentials separate from browser sessions and outbound webhook signing secrets.
No additional identity service or backend user registration is required.

## Authorization

A backend API credential does not permit arbitrary user impersonation by submitting a Tableau username or user ID.
Personal connection access requires an explicit grant.
An operator may assign access to configured service connections.
A backend receiving signed webhooks needs no inbound API credential unless it also calls our service.
Provide independent attribution and revocation for each backend.

## Rationale

A single team-wide key obscures which backend made a request and prevents narrow revocation.
Separate backend credentials are a conventional server-to-server access pattern.
Explicit connection grants are an additional choice needed to limit access within this shared service, rather than a claimed novelty of API-key authentication.
The exact grant mechanism should remain small and must not grow into a user directory or a general identity platform.

## Details still to resolve

Specify credential provisioning, secure storage, verification, expiry/replacement, and the minimal grant representation.
Specify how personal owners authorize grants and how disconnect or account replacement affects them.
Do not interpret this acceptance as approval of every mechanism or lifetime proposed in PROPOSAL-006.

## Required rewrite consequences

Define backend credentials and connection-use grants in access, proxy, jobs, event delivery, SDK/server-client, and persistence contracts.
Keep native provider API access and responses available under these grants without mandatory per-operation wrappers.
Preserve the same credential confidentiality and approved-destination boundaries as browser proxy access.

## Verification boundary

This records accepted server-to-server access direction, not provisioned credentials or tested backend integration.
