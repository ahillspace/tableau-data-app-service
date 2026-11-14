# Design and future implementation verification

Status: proposed checks; no application tests or live integration checks have been run.
The current artifact is a specification, so initial verification consists of consistency review, source provenance, link checking and independent scenario walkthroughs.
The matrix below defines evidence a later implementation must produce.

## Synthetic fixtures

Provider Cedar has no-credential reads, a delegated authorization-code connection, rotating refresh credentials, a paginated read and a keyed write.
Provider Flint has an operator-managed service API key, a derived short-lived credential, a non-expiring credential option and signed invalidation events.
These are invented protocol fixtures, not claims about real products.
The same generic value-read/value-update shapes exercise both providers without embedding messaging, CRM or workflow semantics.
The test boundary supplies verified app and holder contexts; negative tests use untrusted wire input and must be rejected.

## Goal coverage

| Goal | Journey and required observation | Main owners |
| --- | --- | --- |
| 1. App discovery | Two configured apps receive only their enabled capability versions; disabled or unverified apps cannot discover private configuration. | Access, registry, HTTP. |
| 2. No credentials | Cedar public read completes without holder, connection creation, provider login or secret lookup. | Execution, provider. |
| 3. Service identity | Flint service capability uses the exact app binding; a browser-selected replacement connection is rejected. | Access, connections. |
| 4. Delegated identity | Missing holder and missing connection produce distinct requirements; explicit authorization creates an app/holder-owned connection without a user profile. | Access, connections, SDK. |
| 5. No ID-based authority | Another app or holder cannot list, use, disconnect, inspect results for, or receive events about the connection by knowing its ID. | All resource readers. |
| 6. Credential variants | Known expiry, no expiry, unknown expiry, API key and derived credentials each follow their declared lifecycle; unsupported behavior fails before dispatch. | Credentials, provider. |
| 7. Races and ambiguity | Concurrent refresh has one owner; disconnect wins over stale refresh; interrupted exchange and ambiguous write never become unproven success or automatic replay. | Credentials, execution, persistence. |
| 8. Typed reads/writes | Input/output validation, page limits, cursor binding, cancellation, request budgets and write retry policy are exercised through the HTTP/SDK path. | Registry, execution, HTTP/SDK. |
| 9. Events and resync | Invalid signatures fail; duplicates create one event; lost browser delivery replays; expired replay returns resync-required and rereads authoritative state. | Provider, events, SDK. |
| 10. Second provider | Add Flint registration/driver/handler with existing seams and no change to Cedar logic or public API shape. | Composition root and module owners. |

## Cross-module failure checks

- Expire or revoke access after discovery and again after receipt admission; the next dispatch and result disclosure recheck authority.
- Race two identical invocation commands, then reuse the key with changed input; observe one handler and an explicit conflict.
- Change a configured service connection after an invocation, then retry its key; observe the original receipt and no new identity selection.
- Lose a write response, then inspect by request key; observe the same invocation even when the client never received its ID.
- Kill the process immediately before and immediately after the write marker; observe no-effect interruption versus uncertain effect, with no automatic execution on restart.
- Return provider success with an invalid output shape; observe applied-effect failure and no blind retry.
- Complete one of two writes and definitively reject the second; observe a partial-effect result rather than atomic success/failure fiction.
- Lose a rotating refresh response and expire its claim; observe renewal-uncertain and no second refresh using the old token.
- Disconnect while renewal or reauthorization is in flight; stale completions cannot restore a credential or usable connection.
- Replay a callback, swap issuer, omit browser correlation, or reauthorize a different external subject; each attempt fails without replacing the old connection.
- Race authorization completion against app disable; no connection is published under disabled policy.
- Attempt endpoint authority replacement, a forbidden redirect and DNS address substitution; credential-bearing traffic never reaches an unauthorized destination.
- Present a cursor under another holder, connection epoch, query or capability version; reject it without disclosing provider pagination state.
- Delay a feed transaction while another event arrives; no returned high-water cursor skips the uncommitted event.
- Filter private feed rows while paginating; advance safely without exposing the other holder's data or falsely indicating completion before the scan limit.
- Fail the database between event verification and commit; do not acknowledge durable acceptance.
- Fail final receipt persistence after provider success; retain uncertain durable evidence and suppress a second execution.
- Expire output while retaining a command tombstone; report result-expired without reexecuting the write.

## Required implementation evidence

Use real Postgres integration tests for unique claims, conditional updates, commit ordering and restart behavior; in-memory mocks cannot establish those guarantees.
Use a controlled external HTTP fixture for credential rotation, idempotency, redirects, cancellation and deliberate response loss.
Exercise the actual Fastify routes and browser SDK together, then inspect the rendered connection and uncertain-result states in a browser.
Run project-selected type checks, formatting, lint and meaningful tests before a later implementation is described as complete.

Real-provider acceptance separately records supported grant modes, endpoint/identity evidence, renewal rules, permission enforcement, pagination consistency, provider key lifetime and event retry behavior from official documentation and observed tests.
Tableau acceptance separately records tested Cloud/Server versions, hosting mode, supported browsers, popup/top-level authorization return, network/CORS behavior and the chosen request-binding transport.
Until those checks occur, compatibility remains an explicit external dependency.

## Initial freeze record

The frozen independent draft consists of this file, the goal assessment, architecture, shared/module specifications and decisions in this directory.
Its content digest is recorded outside the frozen source tree by the review coordinator.
Comparison with earlier drafts and reviewer findings are separate records and must not retroactively change what the independent initial author proposed.
