# Tableau site access

## Purpose

This slice SHALL implement the canonical [Access registry](../../../../../specs/access-connections.md#trusted-site-registry-administration) and [scoped transaction](../../../../../specs/persistence-operations.md#transactions-concurrency-and-failure) contracts for Cloud and Server.
Scenarios are future tests, not evidence that an application exists.

## ADDED Requirements

### Requirement: Verified configured site identity

Eligibility SHALL use server-verified stable deployment/site identity matched to an enabled entry, without email-domain, personal or per-app enrollment.

#### Scenario: Approved site and external email

- **WHEN** a supported adapter verifies a user from an enabled deployment/site with any email domain
- **THEN** site eligibility succeeds and current owner/shared resource checks still apply.

#### Scenario: Forged or different deployment

- **WHEN** browser-supplied site metadata is forged, the entry is absent/disabled or the same site ID belongs to a different verified deployment
- **THEN** site-bound access is denied.

### Requirement: Protected existing administration

Only dedicated registry-management authority SHALL list or mutate the registry; it SHALL grant neither provider-data access nor viewer impersonation.

#### Scenario: Trusted enrollment integration

- **WHEN** the existing protected enrollment backend supplies valid authority and configured deployment/site input
- **THEN** the service applies the narrow registry operation without another approval/UI gate.

#### Scenario: Wrong caller or unsafe route input

- **WHEN** a viewer/provider credential, spoofed email or arbitrary issuer/discovery host is submitted
- **THEN** management fails without fetching/trusting that route or broadening authority.

### Requirement: Atomic immutable identity lifecycle

Registration SHALL be unique and attributable, duplicate registration SHALL preserve disabled state, and identity edits SHALL NOT migrate private owners/data.

#### Scenario: Concurrent duplicate or failed commit

- **WHEN** equivalent registrations race
- **THEN** one entry exists and duplicate callers see its current state.
- **WHEN** the database cannot commit
- **THEN** no successful mutation is reported.

#### Scenario: Correction and URL alias

- **WHEN** a deployment/site identity is incorrect
- **THEN** register the corrected pair and disable the incorrect pair without transferring private resources.
- **WHEN** an operator changes only a deployment URL alias
- **THEN** preserving its stable identity requires verified continuity under the adapter contract.

### Requirement: Current authority without implicit sharing

Committed disablement SHALL affect subsequent site-bound checks, and enrollment SHALL NOT expand another owner's resources or existing shared audiences.

#### Scenario: Ordinary request snapshot

- **WHEN** site disablement commits before an ordinary native/capability authorization snapshot
- **THEN** that request is denied without a policy shared-lock commit or stale permission cache.
- **WHEN** a request was already authorized before the overlapping disablement
- **THEN** that operation may finish, while each later helper operation/request needs fresh current authority.

#### Scenario: Queued versus started work

- **WHEN** a site is disabled during queued/running work
- **THEN** new site-bound starts/checkouts/disclosure deny while eligible original outcomes may persist without remote rollback or forced cancellation claims.

#### Scenario: New site or second owner

- **WHEN** a site is newly registered or another owner uses the same Data App
- **THEN** no shared account or personal resource is inherited from app/site membership alone.

#### Scenario: Same owner across configured apps

- **WHEN** the same verified owner uses another configured app
- **THEN** personal ownership remains available without a personal app-use binding, while explicit shared verified-site/user audiences remain current.
