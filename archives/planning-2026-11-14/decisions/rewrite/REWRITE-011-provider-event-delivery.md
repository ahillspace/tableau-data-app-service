# REWRITE-011: Optional provider events with separate delivery paths

Current scope: [REWRITE-034](REWRITE-034-data-app-and-provider-boundary.md) supersedes delivery to separate application servers.
Provider ingress and browser SSE remain; the original outbound-backend decision below is historical.

Status: accepted by the user for the architecture rewrite.
Recorded: 2026-11-08.
Audit topic: D10.

## Decision

Offer optional provider event handling, separate from ordinary authenticated proxy requests.
Use Server-Sent Events to push updates to browser Data Apps and extensions.
Use signed outbound webhooks to deliver events to explicitly authorized application backends.
Preserve provider event contents where practical instead of requiring a universal provider event schema.
Add a small delivery envelope containing event identity, provider, connection reference, and event type, with only information the consumer is authorized to receive.
Do not require every provider to implement event support or translate every event into a custom domain model.

## Rationale

A Data App may use our service alongside other backends.
Both browser clients and authorized application backends can need provider notifications.
Shared ingress verification and routing should serve both delivery paths without duplicating provider integration.
The user rejected browser polling as the normal delivery mechanism.
Native provider semantics should remain available, consistent with the proxy-first direction in REWRITE-010.

## Required boundaries

Verify incoming provider events using the provider's supported mechanism before accepting them for delivery.
Authorize subscriptions and delivery audiences by app, connection, and verified ownership as appropriate.
Do not expose provider secrets merely because an event payload is otherwise passed through.
Treat the connection reference as safe metadata, not authority to use that connection.
Sign outbound webhooks and validate configured destinations.
Do not silently fall back to browser polling.
Provider-side polling may still be necessary when an external task API offers no completion callback; this is distinct from browser polling.
A proxy call does not by itself create a live event subscription or complete a provider event integration.

## Required rewrite consequences

Separate provider ingress and interpretation from browser and application-backend delivery.
Reuse provider event handling for both delivery paths.
Keep job state in the job system; job completion notifications can use the event delivery mechanism without becoming a second source of job truth.
Define authenticated SSE connection establishment and renewal consistently with REWRITE-003 rather than assuming native EventSource accepts authorization headers.
Include reconnect handling and test actual Tableau frame, browser, and hosting constraints before claiming reliable streaming support.

## Details still to resolve

Retention periods, replay guarantees, webhook retry duration, ordering, delivery deduplication, backpressure, and expired-history behavior remain architecture-owner proposals requiring explicit resolution.
Earlier suggestions of seven-day retention and 24-hour webhook retries were not separately accepted.
Specify application-backend authentication and subscription configuration without assuming browser credentials can be reused as service credentials.
Do not promise exactly-once delivery, provider event completeness, or automatic recovery from missed upstream events.
Determine the smallest durable event storage needed for the accepted delivery requirements.

## Affected specification areas

Update architecture.md, specs/events-http-sdk.md, specs/contracts.md, specs/providers-execution.md, specs/persistence-operations.md, decisions/choices.md, and verification.md.
Reconcile README.md and PRD.md with multiple backend consumers, optional provider event support, and SSE rather than browser polling.

## Acceptance evidence for the rewrite

Trace one provider event to an authorized browser stream and an authorized backend webhook.
Reject an invalid provider event and an unauthorized subscriber.
Exercise stream disconnection, token expiry, reconnect, webhook failure, duplicate provider delivery, and unavailable historical events under the explicitly chosen guarantees.
Show provider-specific event fields remain usable without requiring a managed capability wrapper.

## Verification boundary

This records accepted interface and transport direction, not tested SSE, provider event ingress, webhook delivery, or browser compatibility.
