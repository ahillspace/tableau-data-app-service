# Round 3 connection verification

Reviewed frozen commit `02ef97a996efb4fbae2b33c6649336730022a16a` with source snapshot SHA-256 `26d3a975bb9083dbe8c713df67f0296ef7ff3eed504ad7a1522ed4dc311027b9`.

I inspected the integrated contracts, core, connections, execution, HTTP/SDK/events and scenario specs, then checked all findings in [round-2-connection-review.md](round-2-connection-review.md) against the integrated wording.

## Residual finding

### P2: Pagination cursor invalidation after restore has no explicit fence

`specs/connections.md:70` requires restore to invalidate existing cursors, but page cursor records in `specs/http-sdk-events.md:160-166` bind app, binding, capability, logical connection revision, input, page size and expiry without retaining `authorityEpoch`.

If a restored cursor survives the recovery procedure and the front door reissues a valid context with the same stable binding ID, a connectionless or unchanged-generation page cursor has no stated field by which the service can reject its pre-restore epoch.

Store the creating authority epoch in each pagination cursor and reject mismatches, or explicitly require the offline restore procedure to purge every cursor repository and return `CURSOR_EXPIRED` for those tokens.

### P2: Derived-credential cache binding differs between credential version and logical grant

`specs/contracts.md:158,206` distinguishes a refresh-only `credentialVersion` change from the stable logical connection revision, and `specs/connections.md:50,202` says derived credentials bind to the parent credential version.

The synthetic journey in `specs/scenarios.md:56` instead scopes a derived credential to the source logical connection revision, while routine refresh leaves that revision unchanged.

After an ordinary parent token refresh, the contract therefore does not establish whether a derived credential remains usable or must be invalidated and re-derived.

Choose whether parent credential version is an active validity fence or provenance only, then use the same rule in the envelope, `DerivationRequest`, cache key, invalidation rules and scenario trace.

## Verification outcome and deferred boundaries

The R2 source resolves the prior restore, callback fencing, connection API, pagination, SDK error, event audience, feed ordering, deduplication, unresolved-write retention, unknown-field and state-machine findings in its shared interfaces or explicit rules.

The authorization, refresh, dispatch, revoke, reconnect and result-read paths now share logical connection revision and authority-epoch checks, while refresh concurrency uses a separate credential version.

The future adapter must still provide current binding validity and initiating-browser continuity before delegated callback activation is enabled; the specs explicitly keep this as a front-door blocker rather than trusting OAuth state alone.

Provider-specific refresh rotation, token expiry, revocation and event redelivery guarantees, the actual front-door transport, and the operator key service remain external implementation inputs rather than contradictions in this frozen contract.

This was source review only; no provider tests, runtime tests or implementation verification were performed.
