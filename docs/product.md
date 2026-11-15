# Product

Tableau Data App Service is an authenticated router between Tableau Data Apps and the external APIs those apps use.
An operator installs it once.
From then on, operators add connection definitions at runtime, and Data App viewers sign in with Tableau and reach each connected provider's native API through the service.
The Data App owns its behavior.
The service owns identity, credential custody, routing, durable Jobs and optional live events.
The service secures what it holds and what it verifies.
It does not secure Data Apps, and it does not impose practices on how an app is built or what it does with the access it is given.

This document has three kinds of statement, kept in separate sections:

- [Requirements](#requirements) are stated by the product owner and are not open to reinterpretation by component designs.
- [Recommendations](#recommendations) are the architecture's proposals for meeting those requirements and may be revised through review.
- [Assumptions](#unverified-assumptions) are facts the design depends on that have not been verified, each with the check that settles it.

Design status: draft, awaiting product owner approval.
Implementation status: not started.
User acceptance: not started.

## Who uses it

- **Data App builders** write front-end Data Apps, often with an AI assistant, and call the service through a small browser SDK.
  They do not register apps, hold secrets or learn the service's internals.
- **Viewers** open a Data App inside Tableau, sign in with Tableau when asked, and connect their own provider accounts when a connection is personal.
- **Operators** run the installation.
  They manage trusted Tableau sites, connection definitions, shared connections and other operators.

## Requirements

### Installation

- R1. An installation is deployed once and is never redeployed or reconfigured on the host to add a provider, change how a provider works, or retire one.
- R2. One installation is one administrative boundary.
  It may trust several Tableau sites.
- R3. A secret is never stored or shown in plain text anywhere: not in configuration files, environment variables, chat, terminal history, logs or the repository.
- R4. Connection definitions are managed through a command-line tool and through an optional HTML setup page.
  The operator deploys that page wherever they deploy the service, and it is never deployed automatically.
  Its design is out of scope for this specification; the specification reserves its place and the API it uses.

### Connections

- R5. The core product is an authenticated router: once a provider is connected, its native API is available to Data Apps through the service.
  Capability or scope gating is not the main path.
- R6. Connecting to a new provider takes little effort and no code for any provider that a generic provider type can describe.
- R7. Redefining a provider may disconnect its existing connections, as long as nothing that refers to the definition breaks.
- R8. A failed operation on a personal connection never falls back to a shared connection.
- R9. A Data App can learn each definition's ownership mode, so it can decide what setup, if any, to show.

### Identity and operators

- R10. Tableau is used only to verify identity.
- R11. An identity is always a Tableau site plus a user on that site, never a username alone.
  The same username on two sites can carry very different assurance, for example a password site and a single sign-on site.
- R12. Every operator is named explicitly by site and user.
  No Tableau role, including site administrator, makes anyone an operator.
- R13. Operators sign in through Tableau.
- R14. Operator authority covers the whole installation and belongs to individuals only.
  There are no operator groups and no operator scopes per app or per site.
- R15. The bootstrap configuration names the first operator by site content URL and Tableau username.
  On that operator's first verified sign-in, the record binds to the site and user identifiers Tableau returns, and the name is never matched again.

### Apps

- R16. Data Apps are recorded automatically the first time the service sees them.
  There is no registration step.
- R17. Data Apps run in the browser and cannot hold secrets, so no app secret exists.
- R18. A malicious Data App published on a site the installation trusts is the site owner's responsibility, not something the service must prevent.

### Sign-in and return visits

- R19. A viewer signs in once, and every Data App reuses that sign-in across reloads, new tabs and return visits, with no prompt, until the sign-in limit is reached.
- R20. How widely restore is shared is reconsidered once the service can verify which Tableau site the calling app runs on (see [Verify app location](#verify-app-location)).

### Hosts

- R21. Tableau Cloud is supported in the first build.
- R22. Tableau Server is not built in the first build.
  The deployment interface leaves room for Server without changes to other components.
- R23. Tableau Desktop is a supported host.
  Desktop runs Data Apps in an embedded Chromium browser, so it uses the same sign-in and request paths as Cloud and needs no separate design.

### Durable work and events

- R24. The service supports Jobs: durable, long-running work that can continue after the page closes.
  Job input and saved results are each capped at 100 MB, and a Job's total runtime at 24 hours.
  Results are kept for seven days and finished-Job records for thirty days.
  Every cap and window is configurable.
- R25. Live provider events are optional.
  An installation without events runs no event infrastructure.
- R30. The first build includes a Slack event source, and Slack is the provider used to verify the event path end to end.

### Operability

- R26. A rejected configuration or definition names the field that failed and why, without printing any secret value.
- R27. Database connections use TLS with a verified certificate.
- R28. The test suite installs and runs on macOS and Linux.
- R29. The browser SDK stays small enough to load quickly inside a Data App.

## Recommendations

### Provider types and connection definitions

- Code defines provider types: generic OAuth 2.0, static token or API key, and presets for specific providers.
- A connection definition is data: an instance of a provider type with its endpoints, client ID, sealed client secret, requested scopes, ownership mode, site audience and reauthorization interval.
- Ownership mode is either **shared**, where an operator connects one account that the definition's audience uses, or **personal**, where each viewer connects their own account.
- A definition's audience is a set of trusted sites.
  Trusting a new site never widens an existing definition's audience.
- Definitions are created and changed at runtime through an operator API that the command-line tool and the setup page both call.
- Every replica picks up definition changes through a single installation revision number in Postgres.
  A replica compares its cached revision before using definitions and reloads when the number has moved.
- Some changes are made in place: enabling or disabling, display name, client secret rotation, reauthorization interval, audience, and added scopes for new grants.
- Other changes redefine the definition and start a new generation: provider type, ownership mode, token mode, client ID and any endpoint.
  Redefining disconnects every connection of the old generation and deletes its tokens.
  The definition ID stays the same, so Data Apps that refer to it keep working once users reconnect.
- An endpoint change is always a redefinition, so a stored token is never sent to a host it was not issued for.
- Retiring a definition disables it, disconnects every connection and keeps its history.
- One OAuth callback route serves every definition, keyed by the authorization `state`.
- Code is reserved for provider presets, optional provider capabilities, Job handlers and event sources.

### Slack preset

- Slack is a preset with a token mode of bot or user.
- One Slack app can back a shared bot definition and a personal user definition at the same time, because one Slack install returns both tokens.
- The preset includes a Slack Events API source that verifies Slack's request signature with a sealed signing secret.
- The preset accepts organization-wide Enterprise Grid installs that return an enterprise without a team.
- A new example Data App demonstrates both definitions.

### Secrets

- Client secrets, tokens and API keys are sealed with authenticated encryption bound to their purpose and record, so a sealed value cannot be moved to another record and opened.
- Operators enter a client secret through a one-time link to a page the service serves.
  The secret never passes through chat, the command line, an agent or the setup page's own code.
- A Data App sends a personal static token or API key to the service through the SDK, however the app obtained it.
  The service seals and stores it, and never returns it.

### Operators

- The command-line tool signs in through a browser handoff to Tableau, in the style of `gh auth login`.
- A command run on the service host recovers access if every operator is locked out.
  It needs host access and no secret.
- The bootstrap configuration holds only the Tableau deployments (Cloud pods), the first trusted site and the first operator.
  Everything else is runtime data.

### Viewer sign-in and sessions

- Tableau Cloud sign-in uses OAuth authorization code with PKCE against Tableau's sign-in service, validates the OpenID Connect response, then asks Tableau's REST API for the current session to obtain the site and user identifiers.
- The service keeps a sign-in session as a cookie on its own origin, and a partitioned restore cookie lets Data App frames restore that session with no prompt.
  It records the time of the last verified Tableau sign-in, and a new Tableau sign-in is required once that time is more than seven days old.
  The interval is configurable, and restoring or refreshing never moves it.
- The Data App holds a bearer in memory only; on load the SDK restores one from the restore cookie.
- The first sign-in in a browser opens a popup from a viewer action, which returns a one-time completion code that the SDK redeems for a bearer together with a proof only that SDK instance holds.
  The bearer never appears in a URL or a cross-window message.
- Restored and app sessions never carry operator authority; operator bearers come only from the operator sign-in page.
- Service API responses allow any calling origin, including the opaque origins that Cloud and Desktop present.

### Verify app location

- App sign-in has one named step, "verify app location", that decides what the service knows about where the calling app runs.
- In the first build this step records the app's declared ID and its site and workbook as attribution only, and relies on a verified sign-in on a trusted site.
- Until a stronger check exists, the service does not verify which Tableau site the calling app runs on.
  The specification says so plainly wherever it matters.
- A later check, such as a Tableau-supported proof of the app's location, plugs into this step without changing any other component.

### App registry

- An app ID is a label the Data App declares.
  The service records it the first time it appears, along with its site and workbook attribution and usage counts.
- The app ID is not access control.
  The controls are the Tableau site's own extension and allowed-origin settings, a verified Tableau sign-in on a trusted site, and definition audiences.

### Native routing

- Requests and responses pass through as the provider and the app send them: any method, path, query, headers, body, status, errors and pagination.
  The service removes only its own bearer and hop-by-hop headers from requests, sets the credential the definition calls for, and removes hop-by-hop headers from responses.
  It sets no request or response size limit, header limit, caching policy or content-type rule on native traffic.
- Provider endpoints are never blocked, including endpoints that create or return provider credentials.
- Bodies stream in both directions with backpressure.
- Neither the service nor the SDK retries a business request automatically.
- Each definition names the API hosts it may reach.
  Destinations are checked at connection time against private, loopback and metadata addresses, TLS is always verified, and redirects never carry credentials.
  An operator may explicitly allow a private host on a definition.

### Jobs

- The Postgres Jobs table is the only durable queue.
- A caller admits a Job explicitly with a submission key, so a repeated submission returns the existing Job.
- Jobs that wait on an external task store its ID and release their execution slot while waiting.
  Verified callbacks advance them.
- A finished-Job record outlives its result so that a repeated submission with the same key still returns the original Job instead of running it again, and a late reader learns the result expired instead of getting not-found.
- Jobs are not retried unless the Job's handler opts in, and an interrupted Job is never replayed blindly.

### Events

- Events use Redis publish and subscribe for fan-out and server-sent events to the browser.
  Delivery is lossy, and clients are told when they may have missed events.
- With events turned off, the service creates no Redis client.
- A Redis failure affects events only.

### Runtime

- One TypeScript codebase on Node with Fastify, Kysely and Postgres, running as API and worker roles that each scale to several replicas.
- One initial set of migrations defines the schema.

## Unverified assumptions

- A1. A Tableau Cloud popup started from a Data App can complete Tableau sign-in and return to the service.
  Verified for Cloud in a browser; a verification gate checks Tableau Desktop.
- A2. A first-party cookie on the service origin persists across popups opened from Data Apps on different Tableau sites and in Desktop.
  A verification gate checks each host.
- A3. Tableau's central sign-in may not reuse a viewer's existing Tableau Cloud session, so the first sign-in may ask for credentials.
  The cause is unknown and needs investigation.
- A4. The signed content token in a Cloud Data App's URL might later prove the app's workbook and site.
  It is undocumented; its lifetime, user binding and support status are unknown, and the service does not depend on it.
- A5. A Tableau Server sign-in adapter can be built against the same deployment interface.
  It has never been verified against a live Server.

## Viewer and operator journeys

| Journey | What happens |
| --- | --- |
| First use | A viewer opens a Data App, clicks sign in, and signs in with Tableau in the popup. |
| Return visit | The viewer reloads, opens a new tab or opens another Data App, and is signed in with no prompt while the last Tableau sign-in is less than seven days old. |
| Shared provider | A viewer on a site in a shared definition's audience calls the provider's native API with no provider sign-in. |
| Personal provider | A viewer connects their own provider account once in the popup, then calls the native API as themselves from any Data App. |
| Static token | A Data App sends a viewer's API key through the SDK, however it obtained the key, and later calls the provider as that viewer. |
| Add a provider | An operator creates a definition with the command-line tool, opens the one-time link to enter its client secret, and Data Apps can use it at once on every replica. |
| Redefine a provider | An operator changes a definition's endpoint, old connections disconnect, and users reconnect to the same definition ID. |
| Retire a provider | An operator retires a definition, its connections disconnect, and its history remains. |
| Long-running work | A Data App admits a Job, the viewer closes the page, and the viewer later reads the result from any Data App. |
| Live events | A Data App subscribes to a provider's events and is told when it may have missed some. |
| Operator recovery | Every operator is locked out, and someone on the service host restores an operator with one command. |
| Desktop | A builder tests a Data App in Tableau Desktop and every journey above behaves as it does on Cloud. |

## Exclusions

- Attributing shared-connection actions to the signed-in viewer is the Data App's responsibility; the service forwards native requests unchanged.
- No per-app permissions, per-app grants or app approval workflow.
- No customer tenancy, billing, user directory, local passwords or identity service other than Tableau.
- No workflow builder, sync engine, arbitrary code hosting or agent runtime.
- No request quotas, rate shaping or fairness scheduling.
- No hosting platform, price, traffic level or service level is selected.
