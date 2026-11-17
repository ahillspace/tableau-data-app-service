# Plan: secret entry, declarative provider intake and the operator console

Status: design proposed, not implemented, not accepted.
This plan does not override the current documents in `docs/`; once built, those documents are rewritten to describe the result as if it had always been the design.

## Requirements stated by the user

- An operator can enter client secrets, signing secrets and provider credentials through the operator API and the `tdas` CLI.
- Most providers can be added without changing the service's code.
- An optional operator website is served by the service itself, protected by Tableau Cloud sign-in exactly like the CLI.
- The website has two separate tabs: one for adding and viewing providers, and one for service status and analytics.
- The website follows Notion as its design reference, with a frosted-glass treatment.
- The website uses no generated-looking cards with a colored accent strip.
- The console is prototyped as an interactive mockup for review before it is built.

## Problem 1: secret entry

### Diagnosis

The current rule that a secret is never typed into a terminal conflates two separate concerns.
Protection at rest is essential, and the service already seals every secret in Postgres.
The input channel is a weak concern: a value read from standard input or a file never reaches shell history or the process list.
Mainstream secret tools accept secrets through their CLI and API, so the one-time secret page is unusual rather than safer.
The page also adds no protection against a stolen operator bearer, which can already add trusted sites and operators.

### Design

- Secrets are write-only fields of the operator API: client secret, signing secret, shared credential and signing private key.
- They are accepted on create, on update and through a dedicated set-secret call.
- They are sealed on arrival with the existing sealing key and purposes.
- They are never returned; views show only whether each is set and when.
- They can be rotated in place without a redefinition.
- Secrets in query strings are rejected.
- No log line, audit entry, error message or validation echo ever contains a secret value, and tests prove it.
- `tdas` reads a secret from standard input when piped, from `--from-file PATH`, or from a hidden prompt on a terminal.
- `tdas` also accepts `--value`, with a warning on standard error about shell history.
- The one-time secret link is removed entirely: its routes, pages, table, validation rule, CLI behavior, tests and documentation.

## Problem 2: provider intake

### Diagnosis

The Data App side is already generic.
The only service-side need a rich provider app has had at use time is more than one API host, and that is already data on the definition.
Everything else a provider app does, such as rendering provider payloads or choosing which credential posts a message, is app code and belongs there.
The intake side is where code is needed today: how a credential is obtained is fixed per preset.
Providers are unbounded, but credential methods are few and standardized.
Every provider-specific behavior observed so far is expressible as data: a scope parameter name and separator, an error reported with a success status, a token nested in the response, an account lookup and a revoke call.
A service-account provider needs one standard method the service lacks, the JWT bearer grant, plus a regional host pattern.

### Design

The credential method becomes declarative data on the definition, chosen from a small closed set of standards-based methods.

| Method | Configuration |
| --- | --- |
| `authorization_code` | Authorize and token endpoints, client authentication `basic` or `post`, scope parameter name and separator, extra authorize parameters, PKCE on or off, token-response JSON paths for access token, refresh token, lifetime and account, separate refresh-response paths when they differ, and an error predicate for errors returned with a success status. |
| `client_credentials` | Token endpoint, client authentication and scopes. |
| `jwt_bearer` | A sealed private key, or a pasted service-account JSON from which the issuer, key, key ID and token endpoint are read; a claims template for issuer, subject, audience and scope; a lifetime of at most one hour. The assertion is exchanged at checkout, the access token is cached until shortly before expiry, and the exchange runs under the same row lock as refresh. |
| `signed_jwt_direct` | A self-signed JWT used directly as the bearer, with no exchange. |
| `static` | Placement as bearer, a named header with an optional prefix, a named query parameter, or Basic authentication. |
| `none` | No credential. |

These are also declarative:

- Account lookup: a request plus JSON paths for the account ID and name.
- Revoke: a request.
- Inbound webhook verification: HMAC algorithm, signed-payload template, signature and timestamp headers, signature prefix and encoding, tolerance window, and a challenge or echo handshake.
  It must cover the common patterns: a versioned timestamp-and-body HMAC, a plain body HMAC, a timestamped signature header with several signatures, and a validation-token echo.

API hosts accept a leftmost-label wildcard pattern such as `https://*-api.example.com`.
The router places a credential only on a host that matches, and the documentation explains why that boundary is safe.

Presets become data templates in a catalog kept in the repository, and a template only pre-fills a definition.
The first templates are a workspace chat provider in bot and user modes, a cloud service-account provider, a generic API key and a generic OAuth 2.0 provider.
Code remains only as a narrow extension point for capabilities and Jobs.
The documentation says when code is justified: a new credential method, such as request signing, never a new provider.

The Data App side stays generic, with no per-provider SDK or router code.
The documentation adds recipes for several hosts on one definition, shared and personal ownership, and streaming responses.

The service is unreleased, so the `0001-initial` migration changes in place and the schema reads as if this model had always been the design.
There are no data migrations or compatibility code for earlier definitions.

### Acceptance

1. A cloud model-inference provider with a service-account key works from its template with no provider-specific code.
   An operator creates the definition, pipes the service-account JSON through standard input, and a Data App calls a model through the native router, both as a single response and as a server-sent event stream.
   A global location uses the provider's global host, and a regional location uses its regional host through the wildcard pattern.
2. The chat provider works from its template plus declarative webhook verification, and an existing app's calls work unchanged.
3. A `client_credentials` provider and an API-key provider pass against test stand-ins.
4. `npm test` on real Postgres, and Redis where relevant, passes, along with type checks, lint and the build.

## Operator console

### Scope

- The service serves the console at `/console` when one setting enables it; it is off by default.
- The console uses only the existing operator API, with no private backend.
- Sign-in uses Tableau Cloud with exactly the same operator check as `tdas`, reusing the existing operator sign-in and consent flow.
- The session is a cookie on the service origin with `SameSite=Strict`, origin and CSRF checks, and a strict content security policy with no runtime CDN.
- A signed-in user who is not an operator sees a clear page saying so.

### Providers tab

- A table of definitions: name, method, ownership, hosts, status, connection count, generation, and enabled or retired.
- A side-peek panel showing one definition's properties.
- Adding a provider from a catalog template or from scratch.
- Editing a definition, setting or rotating its secrets through password inputs that post to the write-only API, connecting its shared connection and retiring it.

### Status and analytics tab

- Health and readiness, version and revision, uptime, replicas and worker heartbeat.
- Database status and events status.
- Request volume and error rate by definition and status code.
- Upstream latency at p50 and p95.
- Token refresh and exchange failures.
- Connections by status, Jobs by state, active sessions and apps.
- The recent audit log with filters.

Each replica writes minute buckets to a Postgres table, pruned by a retention setting, so totals are correct across replicas without a new paid service.
An operator-only JSON endpoint exposes the same data.

### Design

- Notion is the design reference: neutral typography, generous whitespace, database-style tables, property lists, a side peek and quiet icons.
- A frosted-glass treatment uses translucent surfaces with `backdrop-filter` on navigation, the side peek and dialogs.
- Text keeps WCAG AA contrast, and the console honors `prefers-reduced-transparency` and `prefers-reduced-motion`.
- No cards with a colored accent strip, no gradient heroes and no emoji decoration.
- Plain TypeScript bundled with the existing esbuild; small inline SVG sparklines are fine, and any third-party package needs approval first.

### Verification

New verification gates cover console sign-in, rejection of a non-operator, both tabs, and metrics accuracy across two replicas.

## Constraints

- Follow `AGENTS.md`.
- Recommend test-driven development before building, and run one review pass after; fixing review findings is a separate, approved step.
- Keep personal information, deployment names, URLs, account identifiers and provider setup details out of the repository.
- Never print a secret, bearer or key.
- Do not edit `AGENTS.md`, `archives/` or a changelog, and regenerate `docs/specification.html` with its generator rather than editing it.
- Use plain hyphens and one sentence per line in long Markdown.
- In the specification, separate user requirements, architectural recommendations and unverified assumptions, and mark design convergence apart from implementation verification and user acceptance.
