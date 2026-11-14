# REWRITE-030: Stream native HTTP responses and support large transfers

Status: accepted by the user during the final review walkthrough.
Recorded: 2026-11-09.

## Decision

Support incremental native HTTP response streaming through the proxy and browser SDK, including large binary/media responses and provider HTTP event streams.
Replace the unapproved 8 MiB response proposal with the user's proposed 5 GB configured ceiling.
For planning, 5 GB means 5,000,000,000 bytes; it is an explicit deployment setting, not an immutable protocol restriction or a claim about hosting/provider limits.
Any total-size limit must be explicit, documented and justified; no smaller hidden framework, adapter, SDK or front-door ceiling may silently become the service contract.
The precise counted representation for compressed responses and the interaction with partial/range responses remain design details for review.

Forward response headers and body chunks as they arrive, subject to credential and transport filtering.
Protect memory through bounded buffers and backpressure, and release transport resources when clients disconnect or remain stalled.
Do not load a complete response into server memory before returning it.
Do not impose the earlier thirty-second total deadline on a healthy, actively progressing stream.
Connection establishment, first-header and idle/stall policies still require justified configuration and testing.
Streaming does not enable automatic replay after interruption or credential repair.

The SDK exposes the native response stream; consuming the whole body as JSON, text or a Blob is an explicit application choice.
Broker-managed event subscriptions remain a separate optional interface from streaming a provider's own HTTP response.
This decision does not automatically promise WebSocket, gRPC, arbitrary redirect handling or universal provider SDK compatibility.

## Failure and authority boundaries

Before response commitment, a service transport failure can return the normal service-origin error.
After commitment, a transport or limit failure terminates the stream; the service cannot replace the already-sent native status with a JSON error or promise rollback.
Do not manufacture a successful completion marker, append a service error into a native body, or automatically repeat the request.
Whether a consumer can prove that a truncated body is incomplete depends on HTTP framing and the provider's payload protocol; test that boundary explicitly.
The existing authorization/credential checkout boundary remains; this does not require a database authorization read for every network chunk.
Known credential-returning endpoints require assessment before response bytes are released, not a generic retrospective scan of an arbitrary stream.

## Verification

Demonstrate first-byte delivery before upstream completion, responses substantially larger than 8 MiB, and the configured 5 GB boundary with generated data and bounded process memory.
Verify backpressure, slow clients, disconnect cleanup, long active transfers, midstream upstream failures, non-success bodies, native HTTP event streams and compressed response/header consistency.
Exercise actual browser and deployed ingress paths, including authenticated media access, range requests and required provider/CDN routing before claiming those journeys work.
These are future verification requirements; no runtime support is established by this record.
