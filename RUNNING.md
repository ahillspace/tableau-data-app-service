# Local development and operation

Use Node 26.13 or later in the Node 26 LTS line and npm.
`npm ci` installs the checked-in dependency graph, including a project-local LTS executable and Linux x64 Postgres test binaries.
The test database is a real isolated loopback process in a temporary directory and needs neither Docker nor a shared database service.
The binary package is a development dependency, never a production database provisioner.

Run `npm run typecheck`, `npm run typecheck:example`, `npm run lint`, `npm run build` and `npm test`.
Redis integration tests additionally need `REDIS_SERVER` set to an installed absolute Redis executable; each test starts and stops its own temporary loopback process.
Use a disposable database for manually configured test runs.

Copy `.env.example` to a protected environment file and `service-config.example.json` to a protected configuration file.
Set `SERVICE_CONFIG_FILE` to that absolute configuration path.
Replace the database credentials, HTTPS service origin, configured Tableau deployment and encryption key material.
Generate a fresh 32-byte key with `openssl rand -hex 32` and provide it through protected environment custody.
Never commit keys or populated environment files.
The sample resource numbers support a local example only; budget memory, sockets and database connections across every API replica, worker, control pool, command and overlap before selecting deployment values.
A healthy ordinary streaming response has no total duration or byte cap.
An optional native upload byte budget is an operator transport setting.

Load that environment, then run `npm run db:migrate` with the separate migration role and `npm run config:apply` with protected operator authority.
API and worker startup validate the installed schema and configuration without migrating or changing site eligibility.
Registry management uses a separately provisioned random secret whose SHA-256 verifier and actor ID are listed in `registryCredentials`.
The protected registry routes list, register and enable/disable verified deployment/site pairs; duplicate registration preserves disabled state.
Configure explicit CORS origins, including `null` only for the accepted trusted Tableau partition.
A deployment ID cannot silently change its canonical identity destination.

Run `npm run build`, then `npm start` for the API and `npm run worker` for independent core recovery and applicable Jobs/source work.
The worker command supervises a separate child over IPC and confirms its exit before returning capacity.
SIGTERM stops claims, aborts admitted resources and drains within the configured termination grace; unresolved dispatches retain their durable uncertainty rules.
The host should supervise these commands and preserve ordinary Postgres durability.
`/health/live` reports process responsiveness; `/health/ready` separates core schema/database health from optional Events health.
Redis is contacted only when `events` is configured.
Jobs entrypoints, payload threads and scheduler are installed only while declared entrypoints or retained records require them.

The API includes current identity/session routes, provider discovery, personal static/OAuth setup, native proxy, ordinary HTTP capability invocation, site registry management and optional Jobs/Events.
Slack has native authentication/proxy support and `capabilities: []`.
To enable Slack OAuth, configure the client ID, selected bot/user scopes, callback matching `/v1/authorizations/callback/slack`, and either a protected `clientSecretEnv` or an already-enabled public PKCE app.
Changing Slack app settings is a separate operator action.
Refresh uses the same fenced credential writer and preserves the deliberate connector reauthorization time.
See `src/jobs/README.md`, `examples/slack/README.md` and the browser evidence notes in `test/sdk-browser.md` for extension and example commands.

Initial production identity enrollment remains deliberately closed pending the first-browser binding decision.
Cloud and Server adapters, fixed session expiry and returning-browser restoration have deterministic tests; those tests do not establish a safe initial release, actual Tableau browser restrictions or live Slack/Server acceptance.
Production configuration cannot select fixture identity or the test enrollment guard.
The example therefore reports unavailable initial authentication until that decision is implemented and verified.
