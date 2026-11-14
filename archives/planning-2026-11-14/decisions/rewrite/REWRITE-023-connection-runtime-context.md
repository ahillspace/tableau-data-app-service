# REWRITE-023: Connection-specific provider context

Status: accepted by the user for the next specification revision.
Recorded: 2026-11-08.
Coverage finding: PC01.

## Decision

Keep provider-specific runtime information with the authorized connection and use it to resolve native API destinations.
Preserve the reference pattern of distinguishing shared provider/client configuration from account-specific connection configuration, without copying implementation or introducing its whole configuration language.
Support necessary validated context supplied during connection setup, extracted from authorization responses, or obtained through a narrow authenticated provider discovery hook.
Examples include the API instance URL, region, data-center identifier, or account identifier required by that provider.

## Ownership and boundaries

Connections owns persistence and publication with the corresponding authorization and credential revisions.
Provider configuration declares the required fields and interpretation; sensitive runtime context is not ordinary browser display metadata.
Provider endpoint resolution uses the selected connection's validated context under the existing approved-destination and credential-routing protections.
Do not allow a browser-supplied arbitrary host to receive stored credentials.
Preserve or replace fields deliberately on refresh, reauthorization, or account replacement, and reject stale updates using existing revision rules.
A required discovery failure must not advertise the connection as ready for the affected provider API.

## Scope

This is a small provider-extension contract, not a metadata service, generic workflow, new registration per external account, or browser base-URL override.
Do not require every provider to implement discovery when it uses a fixed API host.
Select exact interfaces and fields during implementation for the providers being supported.

## Required specification changes

Describe provider connection inputs, runtime-context acquisition, protected storage, and destination resolution in shared contracts, access/connections, provider extension, and persistence.
Add a synthetic two-instance journey and checks for stale updates and unapproved destinations to verification.
This accepted record does not itself change the currently frozen comparison source; integrate it in the next revision explicitly.

## Verification boundary

This accepts the pattern identified by source research, not an implemented provider or validated live discovery flow.
