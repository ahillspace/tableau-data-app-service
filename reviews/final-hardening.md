# Final architecture hardening disposition

Status: architecture-owner independent comparison and canonical specification hardening, 2026-11-08.
The input was [accepted-025-source.json](accepted-025-source.json), digest `70c1962bd13255b54d93bd7efb63545eaf0034e11cde0970d6d51d76c0854f46`.
Its integration note, accepted decisions and all earlier review/manifests remain preserved.
External comparison evidence is stored outside the product workspace; it is not implementation source material.

## Outcome

The accepted direction remains coherent for several creators/viewers sharing one internal administrative boundary.
No REWRITE-001 through REWRITE-025 decision was reversed or silently superseded.
The input did not yet settle enough cross-module mechanisms for reliable implementation planning, despite describing their intended invariants.
The new [rationale and readiness map](../implementation-readiness.md) connects thirteen architecture choices to reasons, tradeoffs, canonical contracts and evidence V01-V13.

| Area | Concrete hardening | Remaining boundary |
| --- | --- | --- |
| Identity/access | App-bound in-memory bearer candidate, protected popup bootstrap, explicit site audience, app/personal/service/backend grants and current-result disclosure. | Actual Tableau registration/identity evidence and published-browser experience require a prototype and user assessment. |
| Credentials/context | Revision-matched immutable checkout bundle, bounded required discovery, explicit renewal phase/claim/uncertainty rules. | Real provider semantics and the separately discussed context-secret clarification remain explicit. |
| Native proxy | Bounded raw bytes, binary/multipart, supported methods, header transport, service/provider error origin, socket-time destination checks and secret-returning endpoint treatment. | Streaming/arbitrary methods/transparent browser redirects are not initial support; real provider behavior remains unverified. |
| Jobs | One job table/worker loop, canonical admission comparison, claims, no abandoned-handler replay, read-only external observation, verified callback correlation and cancellation/deadline races. | Job-cap recommendations remain unaccepted; live concurrency/interruption tests are required. |
| Events | Bounded API fanout, timestamp/ID/body signed delivery, short attempts, job-ID post-commit notification, source lifecycle ownership/claims and explicit loss. | Browser/front-door streaming, real provider verification/lifecycle and receiver behavior require tests. |
| Operations | One authority guard, encrypted payload ownership, migration command, readiness/shutdown, offline key replacement and safe observability. | Actual hosting/keys and operating drills remain evidence gates. |

All new mechanisms and numeric limits are architecture-owner recommendations, not additional user acceptance or implemented guarantees.
Only the already accepted result/metadata retention defaults are identified as user-accepted numeric policies.
Consent outlasting the service session, secret references in runtime context and atomic admission limits remain separately labeled recommendations/unresolved choices; this review did not adopt them on the user's behalf.
These narrow unresolved choices do not prevent delivery of the design hardening, but an implementation plan must surface them where they affect behavior.

## Verification and limits

The [new source snapshot](final-hardening-source.json) identifies the final canonical sources, including the new readiness map, without replacing earlier manifests.
The existing snapshot script checks source presence, local file links and digest equality only.
Additional checks cover Markdown heading links in the changed documents, preservation hashes for prior reviews/accepted records/archives, and whitespace errors in the diff.
Snapshot generation and verification passed across 48 source files with digest `c9f5457d20fe4f4b6f8053415ff96bd29420f59e461371e89e240d1a8c51ee79`.
All 81 preserved historical files retained their hashes; changed-document local file/heading checks and `git diff --check` passed.
An independent complete-journey consistency read checked native access, owner-bound authorization, refresh, backend use, job/revocation/callback races, event delivery and process lifecycle against the accepted records.
No application, provider, browser, migration, key-rotation, load or security test was run; none is claimed to pass.
Document readiness supports bounded planning and does not establish production readiness or a future audit without findings.
