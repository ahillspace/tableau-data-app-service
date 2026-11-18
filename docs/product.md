# Product

Tableau Data App Service is an authenticated router between Tableau Data Apps and the external APIs those apps use.
An operator installs it once.
From then on, operators add connection definitions at runtime, and Data App viewers sign in with Tableau and reach each connected provider's native API through the service.
The Data App owns its behavior.
The service owns identity, credential custody, routing, durable Jobs and optional live events.
The service secures what it holds and what it verifies.
It does not secure Data Apps, and it does not impose practices on how an app is built or what it does with the access it is given.

## Who uses it

- **Data App builders** write front-end Data Apps, often with an AI assistant, and call the service through a small browser SDK.
  They do not register apps, hold secrets or learn the service's internals.
- **Viewers** open a Data App inside Tableau, sign in with Tableau when asked, and connect their own provider accounts when a connection is personal.
- **Operators** run the installation.
  They manage trusted Tableau sites, connection definitions, shared connections and other operators.

## What it does

### Installation

- An installation is deployed once.
  Operators add, change and retire providers at runtime through the operator API, with no redeploy and no change to host configuration.
- One installation is one administrative boundary, and it may trust several Tableau sites.
- Client secrets, signing secrets and provider credentials are sealed in Postgres and never shown again.
  Operators enter them through write-only API fields, normal CLI input or the optional console.
  Reads expose only whether a value is set and when; logs and diagnostics never contain it.
  The one secret the host holds is the sealing key.
- Operators run the installation with the `tdas` command-line tool, which calls the operator API.
  The optional console uses the same API and operator grant through a same-origin protected cookie.
  Other tools can use an operator bearer from the existing sign-in flow.
- The bootstrap file names the Tableau Cloud pods, the first trusted site and the first operator, and may set the public origin and the sign-in limit.
  Everything else is runtime data.

### Connections

- Once a provider is connected, its native API is available to Data Apps through the service.
  The service does not gate requests by capability or scope.
- Definitions select authorization_code, client_credentials, jwt_bearer, signed_jwt_direct, static or none from one shared protocol engine.
  Grant acquisition, OAuth client authentication and native credential placement are separate.
- [Catalog templates](presets.md) prefill independent definitions, including token mappings, account lookup, revocation, JSON credential import and inbound verification.
  A supported provider needs data only; capabilities and Jobs retain explicit code extension points.
- A connection definition is data with API hosts, typed protocol configuration, scopes, ownership, audience and an optional reauthorization interval.
  Application secrets and connection credentials have separate owners.
- Ownership mode is either **shared**, where an operator connects one account that the definition's audience uses, or **personal**, where each viewer connects their own account.
- A definition's audience is a set of trusted sites.
  Trusting a new site never widens an existing definition's audience.
- Display name, scopes, audience, reauthorization interval, enabled state and secret values change in place.
  Secret rotation invalidates superseded derived credentials across replicas without redefining the provider.
  Ordinary edits and application secret writes never establish or renew machine connection authorization; operators use Connect for local setup or recovery, with token exchange deferred until use.
  Concurrent writes require the safe view version and fail on conflict.
- Every other change is a redefinition: it starts a new generation, disconnects every connection of the old generation and deletes its credentials.
  The definition ID stays the same, so Data Apps that refer to it keep working once users reconnect.
  A change to any endpoint or API host is always a redefinition, so a stored credential is never sent to a host it was not issued for.
- Retiring a definition disables it, disconnects every connection and keeps its history; its ID is never reused.
- Every replica picks up definition changes through one installation revision number in Postgres, checked at most once a second before a checkout.
- A failed operation on a personal connection never falls back to a shared connection.
- A Data App lists the definitions its viewer's site may use, with each one's ownership mode, how it can be set up and the viewer's connection status, and decides what setup, if any, to show.
- A Data App can send a typed personal static or JWT credential through the generic SDK interface, however the app obtained it.
  The service seals and stores it, and never returns it.
- One OAuth callback route serves every definition, keyed by the authorization `state`.

### Identity and operators

- Tableau is used only to verify identity.
- An identity is a Tableau deployment, a site and a user on that site, never a username alone.
  The same username on two sites is two identities, which can carry very different assurance, for example a password site and a single sign-on site.
- Every operator is named explicitly by site and user.
  No Tableau role, including site administrator, makes anyone an operator.
- Operator authority covers the whole installation and belongs to individuals only.
  There are no operator groups and no operator scopes per app or per site.
- Operators sign in through Tableau.
  The command-line tool signs in through a browser handoff to a loopback address, in the style of `gh auth login`.
- The bootstrap file names the first operator by site content URL and Tableau username.
  On that operator's first verified sign-in, the record binds to the site and user IDs Tableau returns, and the name is never matched again.
- The `tdas-admin operators add` command, run on the service host, restores access when every operator is locked out.
  It needs host access and no sign-in.

### Data Apps

- A Data App is recorded automatically the first time the service sees its app ID.
  There is no registration step.
- An app ID is a label the Data App declares.
  The service records it with the site and workbook the app declares and usage counts, as attribution.
  It is not access control.
- Data Apps run in the browser and cannot hold secrets, so no app secret exists.
- The controls on who reaches the service are the Tableau site's own extension and allowed-origin settings, a verified Tableau sign-in on a trusted site, and definition audiences.
  A malicious Data App published on a trusted site is the site owner's responsibility.

### Sign-in and return visits

- A viewer signs in once, and every Data App reuses that sign-in across reloads, new tabs and return visits, with no prompt, until the sign-in limit is reached.
- Tableau Cloud sign-in uses OAuth authorization code with PKCE against Tableau's sign-in service, validates the OpenID Connect response, then asks Tableau's REST API for the current session to obtain the site and user IDs.
- The service keeps a sign-in session as a cookie on its own origin, and a partitioned restore cookie lets Data App frames restore that session with no prompt.
- A new Tableau sign-in is required once the last one is more than seven days old.
  The limit is configurable, and restoring a session never moves it.
- The Data App holds its bearer in memory only; on load the SDK restores one from the restore cookie.
- The first sign-in in a browser opens a popup from a viewer action, which returns a one-time completion code that the SDK redeems together with a proof only that SDK instance holds.
  The bearer never appears in a URL or a cross-window message.
- Restored and app sessions never carry operator authority; operator bearers come only from the operator sign-in page.
- Any Data App shown under the same Tableau host can restore a viewer's session, because the service records the app's declared site and workbook but does not verify which Tableau site the app runs on.
- Data App API responses allow any calling origin, including the opaque origins that Cloud and Desktop present.
  Cookie-authenticated operator requests remain same-origin only.

### Hosts

- Tableau Cloud is supported.
- Tableau Desktop is supported.
  Desktop runs Data Apps in an embedded Chromium browser, so it uses the same sign-in and request paths as Cloud.
- Tableau Server is not supported.

### Native routing

- Requests and responses pass through as the provider and the app send them: any method, path, query, headers, body, status, errors and pagination.
- The service removes only its own headers and cookies and hop-by-hop headers, and sets the credential the definition calls for.
  It sets no request or response size limit, header limit, caching policy or content-type rule on native traffic.
- No provider endpoint is blocked, including endpoints that create or return provider credentials.
- Bodies stream in both directions with backpressure.
- Neither the service nor the SDK retries a business request.
- Each definition names the HTTPS base URLs it may reach, including constrained patterns within the leftmost DNS label.
  A selected host is always concrete; the global host and regional wildcard are separate entries.
  Destinations are checked when each connection opens against private, loopback and metadata addresses, TLS is always verified, and redirects are returned to the app rather than followed.
  An operator may allow private addresses for a definition; metadata addresses are always refused.

### Jobs

- A Job is durable, long-running work that continues after the page closes.
- Job input and saved results are each capped at 100 MiB, and a Job's total runtime at 24 hours.
  Results are kept for seven days and finished-Job records for thirty days.
  Every cap and window is configurable.
- The Postgres Jobs table is the only queue.
- A caller admits a Job with a submission key, so a repeated submission returns the existing Job.
- Jobs that wait on an external task store its ID and release their execution slot while waiting.
  Verified callbacks advance them.
- A finished-Job record outlives its result, so a repeated submission with the same key still returns the original Job, and a late reader learns the result expired instead of getting not-found.
- A Job is retried only when its handler declares retries, and an attempt whose outcome is unknown is replayed only when its handler declares replay safe.

### Events

- Live provider events are optional.
  An installation without events creates no Redis client and runs no event infrastructure.
- Events use Redis publish and subscribe for fan-out between replicas and server-sent events to the browser.
  Delivery is lossy, and clients are told when they may have missed events.
- A Redis failure affects events only.

### Operator console and observations

- The console is served at /console by the same API server and is disabled by default.
  It reuses Tableau sign-in, explicit operator consent and server-side operator checks.
- Providers is a searchable table with property side peeks, template/scratch creation, edits, secret rotation, shared connect and retirement.
- Status & analytics shows health, process heartbeat freshness, connections, Jobs, explicitly defined activity, native request aggregates and audit events.
- Postgres stores bounded minute snapshots; percentiles are computed from merged histogram counts across replicas.
  Metrics are best-effort operational estimates and never become a native-routing dependency.
- The UI distinguishes disabled, unavailable, stale and unknown observations and does not treat events disabled as a Redis outage.

### Operability

- One TypeScript codebase on Node with Fastify, Kysely and Postgres runs as API and worker roles that each scale to several replicas.
- A rejected configuration or definition names every field that failed and why, without printing any secret value.
- Database connections use TLS with a verified certificate.
- The test suite runs on macOS and Linux against locally installed Postgres and Redis.
- The browser SDK minifies to under 15 KiB.

## Viewer and operator journeys

| Journey | What happens |
| --- | --- |
| First use | A viewer opens a Data App, clicks sign in, and signs in with Tableau in the popup. |
| Return visit | The viewer reloads, opens a new tab or opens another Data App, and is signed in with no prompt while the last Tableau sign-in is less than seven days old. |
| Shared provider | A viewer on a site in a shared definition's audience calls the provider's native API with no provider sign-in. |
| Personal provider | A viewer connects their own provider account once in the popup, then calls the native API as themselves from any Data App. |
| Static token | A Data App sends a viewer's API key through the SDK, however it obtained the key, and later calls the provider as that viewer. |
| Add a provider | An operator creates a definition from catalog data or scratch, sets write-only secrets through CLI/API/console and completes its shared or personal setup. |
| Redefine a provider | An operator changes a definition's endpoint, old connections disconnect, and users reconnect to the same definition ID. |
| Retire a provider | An operator retires a definition, its connections disconnect, and its history remains. |
| Long-running work | A Data App admits a Job, the viewer closes the page, and the viewer later reads the result from any Data App. |
| Live events | A Data App subscribes to a provider's events and is told when it may have missed some. |
| Operator recovery | Every operator is locked out, and someone on the service host restores an operator with one command. |
| Desktop | A builder tests a Data App in Tableau Desktop and every journey above behaves as it does on Cloud. |

## Not included

- Attributing shared-connection actions to the signed-in viewer is the Data App's responsibility; the service forwards native requests unchanged.
- No per-app permissions, per-app grants or app approval workflow.
- No customer tenancy, billing, user directory, local passwords or identity service other than Tableau.
- No workflow builder, sync engine, arbitrary code hosting or agent runtime.
- No request quotas, rate shaping or fairness scheduling.
- No hosting platform, price, traffic level or service level is selected.
- The optional console has exactly two top-level tabs: Providers and Status & analytics.
  It is not an app builder, permission portal or provider workflow engine.
