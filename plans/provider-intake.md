# Plan: provider intake, secret entry and operator console

Status: execution authorized, shared design contract established, implementation proof pending integration.
The current documents in docs describe the intended product directly.
Design convergence, implementation verification and live acceptance are separate outcomes.
The system is undeployed and has no existing users, stored credentials or compatibility contracts to preserve.

## User-stated requirements

- Operators enter secrets through normal write-only API and CLI input and may use an optional same-server console.
- Most providers require data only, through separate grant acquisition, client authentication and native credential placement.
- The console has two top-level tabs, Providers and Status & analytics, using a restrained Notion-inspired design with accessible frosted surfaces.
- The Data App owns UI, business behavior and provider usage; the service owns identity, credential custody, routing, Jobs and optional events.
- No provider endpoint policing, app approval, arbitrary expression language or speculative platform machinery is introduced.
- The complete initial schema is authored for this product, without migration/backfill/conversion or compatibility branches for imaginary deployments.
- Real credentials, connection strings, tenant identifiers and deployment details remain outside the repository.

## Architecture decisions

Connections is the sole credential owner, with application secrets separated from shared and personal connection credentials.
One finite protocol engine implements authorization_code, client_credentials, jwt_bearer, signed_jwt_direct, static and none.
Catalog templates copy validated data into independent definitions and never silently mutate them later.
Version checks protect concurrent writes; definition/secret/credential generations protect destinations and cached authority.
The existing outbound transport serves native, token, lookup and revoke requests with socket checks and verified TLS.
Configured inbound primitives cover the bounded Slack, GitHub, Stripe and Graph basic scenarios described in provider-protocol.md.
The optional console uses the same Tableau identity, operator grant, consent and API owner as the CLI.
Postgres stores bounded asynchronous minute snapshots and process heartbeats, with no additional service or synchronous metric write on the native path.
Code extension points remain for capabilities, Jobs and genuinely new protocols.

## Behavioral implementation sequence

1. Establish failing production-path cases for normal secret entry, nested token intake, rotation races, wildcard host selection and operator authority.
2. Rewrite the actual credential/protocol owners and initial schema coherently, removing obsolete entry interfaces and executable provider authentication hooks.
3. Exercise all methods, import/lookup/revoke, typed verification and generic native streaming against synthetic provider servers and independent real database pools.
4. Project the interactive two-tab prototype before UI implementation and keep annotation feedback active while independent backend work continues.
5. Build the console against shared browser-safe data types and the shared operator API, without a private adapter or fallback dataset.
6. Prove two-replica telemetry aggregation/freshness, console sign-in/mutation journeys and failure isolation.
7. Run full tests, typecheck, lint and build, regenerate the offline specification, and preserve unknown-outcome, Job-deadline and response-provenance regressions.
8. Evaluate one final integrated frozen snapshot in a fresh independent substantive review, reporting its findings separately.

## Verification and limitations

The exact behavior gates are V28-V35 in docs/verification.md.
A working prototype is evidence of presentation and interaction intent, not production authentication or provider acceptance.
Graph rich encrypted notifications and automatic subscription lifecycle are outside the implemented primitive contract.
Live Google-shaped acceptance needs an explicitly authorized project, service-account identity, model and location; no new IAM grant, resource or key is implied.
Live Tableau acceptance needs a real supported Cloud site and operator/viewer identity with an accessible service origin.
No live acceptance is claimed until that specific journey is exercised and recorded.

## Current specification map

- docs/connections.md owns credential boundaries, setup, changes and failure recovery.
- docs/provider-protocol.md owns finite protocol schemas, catalog import, host patterns and verification.
- docs/presets.md describes the provider catalog and generic request recipes.
- docs/console.md owns presentation, auth transport and operator journeys.
- docs/metrics.md owns operational observation and aggregate semantics.
- docs/api.md and docs/contracts.md own shared wire surfaces.
- docs/operations.md and docs/running.md own fresh installation and operational commands.
