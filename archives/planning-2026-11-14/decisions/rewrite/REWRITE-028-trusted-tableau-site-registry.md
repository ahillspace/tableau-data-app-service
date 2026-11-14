# REWRITE-028: Trusted Tableau Cloud site registry

Status: user-selected direction during the final review walkthrough.
Recorded: 2026-11-09.

## Decision

Maintain one service-wide registry of enabled Tableau Cloud sites identified by canonical Cloud URL and stable site ID.
Every server-verified user of an enabled site is eligible to use registered Data Apps through the service, regardless of email domain, without individual enrollment or repeated per-app site registration.
An unlisted or disabled site is ineligible.
Site admission is separate from app configuration, private connection ownership and explicit shared-credential grants.
Adding a site does not grant its users another site's private resources or silently widen existing shared-credential access.

## Enrollment boundary

The user will arrange an external enrollment page protected by Google login restricted to Salesforce staff.
That restriction governs who can register sites, not which viewers of an approved site can use the service.
Page construction, Google/front-door configuration and ingestion mechanics are outside this application-design task.
Provide a narrowly protected site-registry maintenance interface for that trusted integration, including registration, listing and explicit enable/disable.
No ordinary viewer, app credential or general backend credential gains registry-management authority.

The enrolling integration is trusted to approve sites; the core does not add a separate Tableau-site ownership challenge or customer signup workflow.
That trust deliberately permits staff to approve a site whose viewers include external customers.
Registry maintenance cannot retrieve provider credentials, impersonate a viewer or grant shared provider access.

## Identity and validation

Match the registry against deployment/site evidence verified through the supported Tableau identity flow, not browser-submitted URLs, IDs or email suffixes.
Use a stable site identifier, not a mutable display name or content path, with canonicalization tied to the supported identity adapter.
Registry entries cannot supply arbitrary authentication issuers, discovery URLs, provider destinations or redirect targets.
Validation and enrollment do not establish that a live Tableau identity flow is supported; that remains a prototype gate.

## Operations and scope

Access owns persistence and current eligibility checks; record the authenticated management client, target and timestamp for registry changes without creating viewer profiles.
Disablement denies new sessions/restoration and subsequent site-bound access, admission, starts and deliveries under existing authorization boundaries.
It does not introduce active-job cancellation or retract already transmitted requests.
Stored personal/provider records are not deleted as a side effect of disabling a site.
No per-site or per-app usage quota is introduced by enrollment; ordinary whole-service resource protection remains a separate decision.

## Design boundary

A dedicated server-side registry-management credential and small HTTP adapter are recommended implementation mechanisms.
The accepted policy does not mandate hosting, Google token handling, UI design or a general administration platform.
No runtime registry, enrollment page, credential or Tableau login has been implemented or tested.
