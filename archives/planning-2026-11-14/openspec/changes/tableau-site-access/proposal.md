# Tableau site access

## Why

Cloud and Server Data Apps need one operator-controlled registry that admits verified site users without email, personal or per-app enrollment.
The existing protected enrollment integration retains its narrow registry-management interface.

## What Changes

- Use configured stable deployment ID plus verified stable site ID for registry identity, supporting both platform adapters without URL-based owner migration.
- Preserve protected listing/register/enable/disable, unique registration, atomic attribution and no implicit re-enable.
- Apply current site checks to sessions, ordinary native/capability read snapshots, explicit Job starts and saved-result disclosure while preserving already-authorized overlap and eligible original outcomes.
- Keep personal ownership across configured apps and explicit shared verified-site/user audiences, without personal app-use or feature grants.

## Capabilities

`tableau-site-access` is a bounded implementation slice of [Access registry](../../../specs/access-connections.md#trusted-site-registry-administration), not a second policy authority.

## Impact

Access/Persistence/HTTP consume the existing shared interfaces; external enrollment UI, administrator identity, deployment and site-approval decisions remain outside this change.
The local registry implementation is exercised with real Postgres in `test/authority.test.ts`.
The historical Cloud login observation does not establish full sessions or Server compatibility.
