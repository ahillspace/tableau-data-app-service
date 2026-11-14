# Native response streaming

## Purpose

This slice SHALL implement the owning [Transport](../../../../../specs/providers-execution.md#native-forwarding-and-transport) and [HTTP/SDK](../../../../../specs/events-http-sdk.md#native-request-carrier) contracts without redefining their policy.
The scenarios below are future behavioral acceptance, not executed tests.

## ADDED Requirements

### Requirement: Incremental native delivery

The service SHALL expose native supported headers/body before EOF without whole-response buffering, including native errors and provider HTTP streams.

#### Scenario: Large response and slow reader

- **WHEN** a supported provider sends a large/long progressing response to a slow Data App
- **THEN** first chunks arrive before EOF, bounded backpressure limits pending resources, and no arbitrary total-byte cap or short total-duration deadline truncates healthy progress.
- **THEN** a usable credential uses the coherent read-only authorization snapshot with zero logical writes, and no Job or saved payload is created merely for the transfer.

#### Scenario: Provider HTTP event stream

- **WHEN** a native provider stream passes through the proxy
- **THEN** its framing remains native without Redis/SSE broker envelopes or injected heartbeat bytes.

### Requirement: Representation integrity

The service SHALL preserve encoded bytes and matching safe metadata under the shared carrier/header profile.

#### Scenario: Compressed range or HEAD

- **WHEN** the provider returns encoded 206, HEAD or another bodyless response
- **THEN** bytes/length/encoding/range/validators stay coherent, partial accounting uses transferred bytes and HEAD/bodyless accounting is zero.

#### Scenario: GET or HEAD with body

- **WHEN** the SDK receives a supplied body for GET/HEAD
- **THEN** its automatic POST carrier reaches the original upstream method/body and correct multipart boundary without endpoint opt-in.

#### Scenario: Native redirect

- **WHEN** a provider returns 3xx or responds to a tunneled HEAD
- **THEN** the explicit physical 200 carrier exposes native status/safe headers with incremental or null body, no automatic follow and no second browser decoding pass.

#### Scenario: Oversized header control

- **WHEN** known input or actual parser/ingress metadata exceeds the one supported profile
- **THEN** the responsible boundary rejects without truncation and reports only the service/unmarked/network failure it can actually establish.

### Requirement: Credential recipient and custody

The service SHALL enforce the canonical approved destination, socket-time TLS/recipient and entrusted-header contract while preserving native permitted provider behavior.

#### Scenario: Deliberate private provider

- **WHEN** an operator configures a supported narrowly scoped private destination
- **THEN** it can receive its intended credentials, while request-driven metadata/control or arbitrary credential redirection remains denied.

#### Scenario: Native new credentials and entrusted retrieval

- **WHEN** provider permissions intentionally return newly created credentials
- **THEN** native output is allowed without generic mint/export classification or scanning.
- **WHEN** a specifically known endpoint returns this service's entrusted authenticator
- **THEN** its narrow documented custody exception prevents that secret's disclosure.

### Requirement: Honest termination and actual browser proof

The service SHALL distinguish precommit service errors from late stream failures, release resources and never automatically replay a business request.

#### Scenario: Abort or postcommit failure

- **WHEN** the browser aborts or forwarding fails after headers
- **THEN** local resources close, no JSON/success marker is appended and no remote rollback is claimed.

#### Scenario: Published media consumption

- **WHEN** Cloud/Server support is claimed
- **THEN** actual authenticated image/video/download and range behavior is demonstrated through the chosen ingress, without reusable query bearer or full-video buffering standing in for that proof.
