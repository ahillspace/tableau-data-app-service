# Native response streaming design

## Context and ownership

This future [B05/B08 slice](../../../planning/build-plan.md#b05---native-streaming-proxy-journey) implements the canonical [Transport](../../../specs/providers-execution.md#native-forwarding-and-transport) and [wire](../../../specs/events-http-sdk.md#native-request-carrier) contracts.
Transport owns upstream sockets/bytes/disposal, HTTP owns framing/carriers, SDK exposes native Responses, and Access owns current checkout.
No second transport specification or new service is introduced.

## Design

Use a maintained low-level Node client with transparent decompression disabled, pipe encoded bytes with backpressure and propagate aborts without body accumulation.
A coherent read-only snapshot supplies current authority and a usable bundle before external I/O, with zero logical writes or policy shared-lock commit; no database lock spans stream lifetime or each chunk.
Downloads and large responses remain ordinary HTTP; neither a capability name nor size creates a Job or saved payload.
The same guarded recipient policy supports approved public/context-derived and deliberately configured private providers while denying metadata/control redirection.

Use the shared automatic request carrier for supplied GET/HEAD bodies and physical 200 response carrier for native 3xx/tunneled HEAD.
The [response carrier](../../../specs/events-http-sdk.md#native-response-carrier) owns null-body framing, physical compression, single browser decode and synthetic Response properties.
The [header profile](../../../specs/events-http-sdk.md#header-budgets-and-control-integrity) owns derived encoded/physical bounds, known-input SDK checks and authoritative runtime enforcement.
Browser manual redirect opacity is handled by that explicit contract, not guessed direct inspection.
M08 assigns service origin to A39 handler-built/transformed Responses and preserves provider origin only for unchanged M05 pass-through; A18 carriers remain provider-only.
A39 uses the same carrier for supported 3xx, including null-body 304, while streamed 200 stays direct; reserved controls cannot be supplied by handlers/providers and unexpected front-door redirects still fail.
Use the shared V05/V14 behavioral evidence for origin, framing, spoofing and failure cases rather than duplicate tests for each reference.

There is no arbitrary total response-size cap.
Measure actual encoded upstream body bytes for diagnostics and justified provider-specific constraints, with partial 206 bytes and zero for HEAD/bodyless responses.
Bound aggregate bytes/sockets/parser resources and independent no-progress waits rather than truncating healthy large streams.
Intentionally returned new provider credentials remain native results; actual entrusted authenticator retrieval keeps its narrow documented exception without generic scanning.

## Failure and recovery

Before response commitment, expose the service error contract; afterward terminate the body without appending JSON or claiming clean native completion.
Framing/protocol determines whether a client detects truncation, so test fixed-length, chunked, compressed and provider-stream cases honestly.
Release unread resources on abort/disconnect without draining or replaying.
A local failure does not prove no provider effect.

## Evidence and extension

Actual Cloud/Server native requests/media, header/ingress behavior, private routing and provider interoperability require V05 proof.
The earlier carrier/gzip/header probes are partial primitive evidence only.
Media element authentication remains an actual-journey gate, not a reason to invent reusable URL bearer tokens or buffer a whole video.
Future explicit redirect following or other transports require their own narrow recipient/method/body contract; they are not automatic retries.
No migration or deployed compatibility claim exists, and this change remains unarchived until implementation/evidence is complete.
