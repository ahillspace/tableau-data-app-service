# Streaming implementation tasks

Status: future work only; no task is implemented or verified.
Use the owning contracts and [V05](../../../verification.md#v05---native-http-files-and-media), not older frozen response-cap proposals.

## 1. Integrate the supported transport

- [ ] 1.1 Verify coherent current read-only authority/bundle snapshots, zero-write usable routing and recipient primitives and actual Cloud/Server session transport for release tests; confine temporary identity to fixtures.
- [ ] 1.2 Implement low-level encoded response streaming with no transparent decompression/recompression or whole-body parser/log/retry storage.
- [ ] 1.3 Integrate backpressure, bounded aggregate buffers/sockets and separate connect/header/upstream/downstream stall handling with no arbitrary total response cap.
- [ ] 1.4 Implement explicit operation/body disposal and precommit versus postcommit failure without automatic replay.

## 2. Preserve native wire behavior

- [ ] 2.1 Integrate generic GET/HEAD-body POST selection, FormData boundary behavior and native upstream method/body without endpoint opt-in.
- [ ] 2.2 Implement inspectable no-follow 3xx/tunneled-HEAD response carriers, correct physical encoding/null-body framing and one browser decoding pass.
- [ ] 2.3 Use one shared codec/header profile with derived JSON/base64url/physical budgets, reserved control protection and honest early parser/ingress errors.
- [ ] 2.4 Verify native status/errors/pagination/ranges/validators, intentionally returned new credentials and narrow known entrusted-secret retrieval handling.

## 3. Prove the actual journey

- [ ] 3.1 Run generated large/long native responses, uploads and provider HTTP streams with fast/slow/concurrent readers; record memory/time-to-first-byte/cleanup and absence of Job/body persistence without giant committed fixtures.
- [ ] 3.2 Test socket-time DNS/TLS/recipient enforcement including explicit private providers and denied metadata/control redirection.
- [ ] 3.3 Run actual Cloud/Server media/download/range and carrier journeys through selected ingress with realistic headers, compression, late failures and disconnects.
- [ ] 3.4 Record relevant build/type/lint/browser/provider evidence and unresolved support limits; archive only after implementation and review, never from document convergence alone.
