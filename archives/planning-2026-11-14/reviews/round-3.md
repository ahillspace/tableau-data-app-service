# Round 3 - Scenario verification and closeout

Status: agent-reviewed proposal; no user acceptance or implementation verification is claimed.
Input: local commit `02ef97a`, [round-2-source.json](round-2-source.json), aggregate SHA-256 `26d3a975bb9083dbe8c713df67f0296ef7ff3eed504ad7a1522ed4dc311027b9`.
Two Luna workers performed bounded source reviews of complete journeys and the previous corrections, without source mutation.
The original reports remain in [connection verification](round-3-connection-review.md) and [execution verification](round-3-execution-review.md).

## Final corrections

- Pagination and event cursors explicitly carry authorityEpoch and reject pre-restore reuse.
- Derived credentials use parent credentialVersion as an active local validity fence as well as logical revision; rotation invalidates local use and requires re-derivation without claiming remote revocation.
- Execution reads and idempotency replays compare stored authorityEpoch to the current context and deployment; old keys remain barriers, and restore write admission remains gated on backup-gap disposition.
- Definitive validated success from the current worker can commit despite a pending cancellation, while stale or already-terminal outcomes remain fenced.
- PaginationDeclaration requires page limits for cursor capabilities and publishes those limits through discovery.
- ProviderOperationDefinition requires parameter and response schemas, with broker validation and honest post-write response uncertainty.

The orchestrator also clarified SDK retry scope, connection targets after disconnect, CORS response headers and schema validation's limits as a secret detector.
These are narrow corrections to the reviewed boundaries, not new product features.

## Evidence and remaining decisions

The final source manifest is [round-3-source.json](round-3-source.json); the closeout confirmations identify its exact digest and commit.
Structural validation covers source-manifest matching, document titles/local links, whitespace, complete HTTP mapping for the 16 shared error codes, terminology consistency and presence of all ten scenario traces.
Manual agent review traces trust, credential changes, dispatch/cancellation, retention, result disclosure, cursor recovery and event commit order across module boundaries.
No application code was implemented, no runtime or provider tests ran, and no Tableau environment was verified.

The intentional open decisions are the trusted front door and callback continuity proof, stable binding/rebinding, actual Tableau environment/browser support, a first provider's lifecycle guarantees, secret/key and external recovery-epoch operations, and production retention/capacity choices.
The final design does not pretend those mechanisms already exist.
Future implementation should first resolve the relevant boundary and then exercise the ten acceptance scenarios with real persistence concurrency and controlled provider failures.

## Targeted closeout

Final frozen source commit: `6d22222`.
Final aggregate source SHA-256: `423a982749928069c49a464806dc24d37395b4dc332fb93b2d9faff13facc02f`.
Both reviewers appended targeted confirmations of their exact residual findings against that source without another exploratory round or source mutation.
All six residual findings are closed in the specification text; the deferred external decisions above remain open.
The orchestrator reran the manifest comparison, local-link/title checks, whitespace check and structural error/pagination/schema/scenario checks on that frozen source; all passed.
The manifest's initial creation briefly reported its own not-yet-created README link; regenerating it after creation resolved that structural dependency without changing the source digest.
No executable TypeScript package exists and no pseudotype compilation or behavioral test is claimed.
