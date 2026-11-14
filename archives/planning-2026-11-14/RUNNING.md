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

Functional production login is enabled with the configured Cloud or Server adapter.
The user explicitly deferred initial cross-client silent-enrollment hardening: an attacker controlling an initiation proof can arrange a victim's silent Tableau login into that transaction and redeem the session from the attacker's client.
PKCE/state, expected popup/window/proof correlation, callback cookie matching, one-use redemption and fixed restoration expiry remain enforced.
There is no additional confirmation screen, ancestry helper or browser restriction.
This residual exposure is deferred, not solved; actual Tableau embedding and live Slack/Server acceptance remain unproved.
Production configuration cannot select fixture identity.

## Installed provider configuration

`src/installed.ts` is the one trusted source inventory consumed by the configuration command, API and worker.
Install provider declarations, matching optional Job declarations and event verifiers there through ordinary source imports.
The existing `application.ts` exports remain available to callers.
The protected JSON `providers` array contains registration metadata only: `{id,revision,enabled,mode,reauthSeconds}`.
Its ID, revision and mode must match the trusted installed provider declaration; reauthorization policy is explicit and nullable.
Every installed additional provider needs its metadata entry, including an explicitly disabled registration.
Configuration publication and role startup use the same complete registration inventory, including the separately configured Slack registration.
Uninstalled declarations, duplicate IDs, mismatched versions/modes or enabled database rows that differ from the installed inventory reject before readiness.
No configuration field loads executable code or changes Slack's empty capability list.
`test/installed-providers.test.ts` exercises the production configuration/application path with a test-only non-Slack ordinary capability and explicit Job, using independently constructed API/worker applications and their separate pools.

## Protected operator setup

Registry credentials and shared-connection operator credentials are separate high-entropy roles.
Generate each role secret as 32 random bytes encoded with unpadded base64url, then store only its SHA-256 hex verifier beside a stable actor ID in the corresponding `registryCredentials` or `operatorCredentials` array.
Duplicate role verifiers are rejected.
Keep the original bearer in protected operator custody, outside the Data App/browser configuration.
The registry role cannot act as a viewer or shared-connection operator.

For an operator-mode Slack registration, POST JSON to `/v1/operator/apps/:app/connections/static` with the role bearer and `{providerRegistrationId,inputs,audience,replacement?}`.
Each audience entry is `{deploymentId,siteId,subjectId}`; subject `*` explicitly selects all users of that enabled site, while an empty array grants nobody.
`inputs` follows the installed provider's setup schema; Slack static setup accepts `{token,tokenMode}`, where tokenMode is `bot` or `user`.
`replacement` is `{connectionId,expectedAuthorityGeneration}`.
OAuth uses POST `/v1/operator/apps/:app/authorizations` with the canonical authorization inputs and explicit audience, then the same correlated popup launch/callback flow as personal setup.
Operator status/cancel commands are GET `/v1/operator/apps/:app/authorizations/:id` and POST `/:id/cancel`.
These commands do not create an operator website or grant a viewer impersonation role.
Provisioning another site does not expand any existing audience.

The worker health-only listener binds `HOST` and `WORKER_HEALTH_PORT` (default 3001), separate from API `PORT` (default 3000).
Protect both health listeners through host/network policy.
Worker readiness includes current core maintenance, applicable Jobs and configured source maintenance; process liveness is separate from dependency availability.
The worker listener registers no business routes.

## Environment loading and key maintenance

The example environment uses dotenv syntax.
Use the host's protected environment loader, or Node's `--env-file` with the compiled commands after building:

```sh
node --env-file=/protected/service.env dist/db/migrate.js
node --env-file=/protected/service.env dist/config-command.js
node --env-file=/protected/service.env dist/api.js
node --env-file=/protected/service.env dist/worker.js
```

Do not shell-source unquoted JSON key values.
Migrations use the migration role's environment; normal API/worker processes use the least-privilege service role.
Cloud configuration requires the canonical pod origin and served public client-metadata path.
Server configuration requires its canonical origin, stable expected site ID, target content URL, REST API version and an actually supported registered integration-service client type with `/Callback`.
Do not impersonate the Tableau MCP client type or reuse Cloud token endpoints for Server.
Custom Server registration/live compatibility must be established by the operator before claiming that deployment is supported.

Offline key replacement accepts downtime:

1. Stop every API, worker and maintenance writer and disable all host automatic replacement/restart.
2. Preserve the old keys, new key and recovery evidence in protected custody, and configure both keys for the maintenance command.
3. Run `npm run keys:reencrypt -- --from old-id --to new-id --working-bytes 2200000000 --writers-stopped` under the protected environment.
4. If interrupted, keep writers stopped and rerun with the same old/new keys; authenticated metadata and conditional per-record updates allow resumption.
5. After complete coverage/integrity verification, switch the active key and reopen compatible processes; retain old keys while backups require them.

The command includes connection bundles, session transaction state, provider authorization state, event-source context and every Job input/result/task payload.
It loads one protected envelope at a time, bounds its working bytes and does not emit plaintext artifacts.
It holds an exclusive advisory maintenance lock against another rekey and rejects live normal service database sessions.
Those database checks cannot prove host restart exclusion: `--writers-stopped` is an explicit operator precondition, not an automatic infrastructure control.
The example working-byte number must cover the largest actual envelope and host headroom; it is not a product payload limit.
A failed command retains old/new keys and uncertainty evidence and never automatically reopens writers.
