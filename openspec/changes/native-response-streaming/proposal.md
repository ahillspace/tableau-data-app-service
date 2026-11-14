# Native response streaming

## Why

Cloud and Server Data Apps need incremental native files/media/provider HTTP streams with bounded live resources.
Streaming a large response or download does not require a durable Job, saved input/result or a capability permission system.
The owning [transport contract](../../../specs/providers-execution.md#native-forwarding-and-transport) preserves bytes/headers and removes the arbitrary total response cap.

## What Changes

- Add low-level encoded byte forwarding, backpressure and bounded connect/header/stall handling without a short healthy-stream total deadline.
- Reuse generic GET/HEAD-body POST and inspectable no-follow response carriers with one shared header profile.
- Preserve native intentional provider-created credentials while protecting actual entrusted authenticators through the narrow known-retrieval exception.
- Verify real browser/ingress/media behavior and honest precommit/postcommit failures without business replay.

## Capabilities

`native-response-streaming` is a new bounded implementation slice, not a new application or platform.
The canonical component contracts remain the authority; this package records acceptance scenarios/tasks.

## Impact

Future Transport/HTTP/SDK and their browser/provider/host fixtures are affected.
No runtime exists, and this proposal authorizes no implementation/deployment.
Local-file upload shares the transport in B05, while this change focuses on response delivery and its carrier integration.
Session/media transport remains evidence-dependent and no reusable query bearer or whole-body workaround is selected.
