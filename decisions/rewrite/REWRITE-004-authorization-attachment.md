# REWRITE-004: Bind provider authorization to its initiating owner

Status: accepted by the user for the architecture rewrite.
Recorded: 2026-11-07.
Audit topic: D04.

## Decision

Bind each provider authorization attempt to the initiating verified backend session, configured Data App, and Tableau ownership context established under REWRITE-003.
Possession of an authorization locator alone must not authorize attaching an external account to another owner.
Validate completion against the specific initiating transaction, with expiry and single-use completion.
Require explicit authorization to replace an existing connection and deliberate handling of a changed external account.
Use established protocol libraries and standard OAuth transaction controls, including state and PKCE where supported, rather than inventing an authentication protocol.

## Rationale

A copied or transferred authorization link must not silently attach the completing person's external account to someone else's connection.
Securing transaction ownership is distinct from proving that a Tableau account and external provider account represent the same person.
Standard OAuth controls are necessary ingredients, not by themselves proof that a transferred-link attack is prevented.
The complete launch and completion journey must preserve and verify the initiating ownership binding.

## Account policy

Allow the authorized Tableau owner to connect a different external provider account.
Do not require matching email addresses as identity proof.
Show safe connected-account metadata where supported and make replacement explicit.
No general organizational account restriction was selected; any later integration-specific restriction requires explicit policy and provider evidence.

## Required rewrite consequences

Specify authorization launch, callback correlation, ownership verification, expiry, duplicate completion, cancellation, and replacement behavior consistently across access, connections, HTTP, and SDK contracts.
Do not treat an OAuth state value or transaction URL as sufficient connection-use authority.
Reconcile transaction binding with popup behavior and the session mechanism validated under REWRITE-003.
Preserve identity and account-change evidence only where the provider actually supplies it.
Do not promise non-transferability through a mechanism that only correlates a callback with a transaction.

## Details still to resolve

The architecture owner must define the exact launch and completion checks that prevent wrong-owner attachment in the supported browsers.
Define how expired sessions, concurrent attempts, and explicit replacement interact without weakening the ownership invariant.
Specify an honest result when a provider cannot supply stable external account identity.

## Affected specification areas

Update architecture.md, specs/access-connections.md, specs/contracts.md, and specs/events-http-sdk.md.
Reconcile provider hooks and identity evidence in specs/providers-execution.md.
Update decisions/choices.md and verification.md.

## Acceptance evidence for the rewrite

Trace a normal authorization and an explicit replacement of an existing connection.
Challenge the flow with a copied locator completed in another browser/session, swapped callbacks, expired transactions, and duplicate callback delivery.
Show that a different external account is permitted only through the authorized owner's intended connection flow.
Account for session expiry and provider identity limitations without claiming matching email establishes identity.

## Verification boundary

This records accepted policy, not a tested launch or callback implementation.
Live browser and provider verification remain required.
