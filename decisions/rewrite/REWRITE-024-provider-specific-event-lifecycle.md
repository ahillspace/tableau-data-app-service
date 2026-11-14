# REWRITE-024: Provider-specific event lifecycle and native access

Current scope: [REWRITE-034](REWRITE-034-data-app-and-provider-boundary.md) removes separate application-backend consumers and recipients.
Provider-specific lifecycle, operator/Data App/service setup and browser SSE remain; references below to external backend consumers are superseded.

Status: accepted and locked by the user for the next specification revision.
Recorded: 2026-11-08.
Coverage finding: EV01.

## Decision

Decide how events are configured, received, verified, routed, and maintained per provider, following the provider's supported mechanisms.
For each supported event source, state who owns setup: operator/manual configuration, the consuming application/backend, or our service.
Use subscription creation, renewal, and retirement hooks only when the provider and chosen integration require them.
Do not build a universal automatic subscription manager or require per-viewer subscriptions for providers with app-level event configuration.

## Data App interface

Data App authors may use native provider API methods through our authenticated proxy.
Optional helpers or configurations may simplify setup and common operations without becoming mandatory provider API wrappers.
Incoming live events use our browser delivery interface, SSE, while preserving native provider event data within the accepted small delivery envelope.
A native provider REST request does not itself establish a browser event stream.
Provider subscriptions and browser subscriptions have distinct lifetimes and ownership.
Closing a browser does not automatically remove a provider-wide source configuration.

## Conditional provider machinery

When our service manages an upstream subscription, provider code can create, renew, or retire it using shared credentials and existing execution infrastructure.
Keep necessary source identifiers, secret references, expiry, and account association with protected provider/connection context rather than introducing a metadata platform.
Manual setup is a valid supported mode; document required provider configuration and what is not automated.
Retire obsolete local routing associations and apply existing replacement/revision rules to late lifecycle updates.
Remote cleanup is best effort where supported, not an implied durable workflow engine.

## Scope and relationships

REWRITE-011 and REWRITE-022 retain live SSE, signed backend webhooks, short delivery retries, and explicit possible notification loss.
No event archive, replay protocol, sync engine, or multi-day delivery queue is added.
REWRITE-023 supplies the shared connection-context pattern where lifecycle state is connection-specific.
The Slack walkthrough illustrates manual app-level configuration; it does not choose Slack as the initial core provider or require a Slack-specific UI.

## Required specification changes

Clarify event-source setup/lifecycle ownership and optional provider hooks in provider extension, event, connection, and verification contracts.
Preserve native API access and optional conveniences in the SDK documentation.
This record is an accepted input for the next explicit revision, not a mutation of the earlier frozen audit source.

## Verification boundary

No live provider subscription, Slack callback, browser stream, or renewal flow has been tested.
