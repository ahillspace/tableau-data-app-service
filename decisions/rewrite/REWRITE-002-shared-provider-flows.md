# REWRITE-002: Shared provider flows with narrow hooks

Status: accepted by the user for the architecture rewrite.
Recorded: 2026-11-06.
Audit topic: D02.

## Decision

Implement common authentication protocols and lifecycle flows once in the core.
Providers supply declarative configuration and narrow optional hooks for behavior that differs.
Do not require each provider to implement its own complete authentication lifecycle.
Preserve explicit treatment of credential-breaking configuration changes without introducing a general migration framework for ordinary updates.

## User requirement and rationale

The user explicitly wanted provider-specific behavior without bespoke flows for every provider.
A standard provider should reuse the shared protocol implementation.
An unusual provider should add only its actual differences.
This keeps additions small while preserving clear ownership and avoiding repeated security-sensitive lifecycle code.

## Required rewrite consequences

Separate reusable protocol implementations from provider configuration, optional hooks, and capability handlers.
Use configuration for supported endpoints, scopes, authentication methods, and request parameters.
Use hooks only where configuration cannot express a documented difference, such as token response parsing, extra refresh parameters, or credential-error interpretation.
The core retains control of connection authority, credential storage, refresh coordination, job execution, and authorization checks.
Ordinary provider code fixes and compatible configuration changes must not automatically invalidate existing connections.
Explicitly handle changes that alter credential meaning or make existing credentials incompatible.
Retain validated endpoint policy and prevent configuration changes from silently redirecting credentials to an unauthorized destination.

## Details still to resolve

The architecture owner must define the smallest useful hook contracts and compatibility classification.
Specify which changes require reauthorization, migration, rejection, or no connection action.
Do not treat every provider module version or configuration edit as a credential-breaking revision.
The earlier suggestion to track granted permissions and check them per capability remains a proposal to reconcile with existing permission contracts, not a separately accepted mechanism.

## Affected specification areas

Update provider ownership and extension guidance in architecture.md and specs/providers-execution.md.
Reconcile provider, protocol, credential, and permission interfaces in specs/contracts.md and specs/access-connections.md.
Update decisions/choices.md and verification.md to reflect shared flows, optional hooks, and compatible configuration changes.
Review persistence requirements for any revision mechanism that no longer has a justified invariant.

## Acceptance evidence for the rewrite

Show a standard synthetic OAuth provider added primarily through configuration and capability code.
Show a second synthetic provider adding one unusual behavior through a narrow hook while reusing the shared lifecycle.
Show a compatible update preserving existing connections and an incompatible credential change receiving an explicit disposition.
Show that neither provider duplicates storage, refresh coordination, authorization, or job plumbing.

## Proxy-first compatibility clarification, 2026-11-08

A provider can be added for authentication and proxy access without implementing managed capabilities.
Provider configuration establishes approved destinations and shared authentication behavior; operation handlers are optional.

These clarifications apply REWRITE-010 and do not introduce a separate product decision.
