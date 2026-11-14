# Tableau Data App Service

A TypeScript backend for Tableau Data Apps on Cloud and Server, built with Node LTS, Fastify, Kysely and Postgres.
It verifies service identity, keeps provider credentials on the server and streams native provider HTTP requests and responses.
The API and supervised worker run as separate processes from one codebase.

Slack includes native static/OAuth authentication and proxy access with `capabilities: []`.
Installed providers can optionally add ordinary HTTP capabilities, explicit durable Jobs and verified Events.
Jobs use Postgres; Events use optional lossy Redis Pub/Sub.
When Events are disabled, no Redis client or deployment is required by the application.

## Quick start

Use Node 26.13 or later in the Node 26 LTS line and npm.

```sh
npm ci
cp .env.example .env
cp service-config.example.json service-config.local.json
```

Keep the populated configuration outside version control.
Set `SERVICE_CONFIG_FILE` to its absolute path, replace example database/deployment/origin settings and supply fresh encryption keys through protected environment custody.
The sample contains no production credentials.
Follow the [run guide](docs/running.md) for registry/operator provisioning and Cloud/Server registration requirements.

```sh
npm run build
node --env-file=.env dist/db/migrate.js
node --env-file=.env dist/config-command.js
node --env-file=.env dist/api.js
# Run the supervised worker in another terminal with the same environment.
node --env-file=.env dist/worker.js
```

Run `npm run example` for the [Slack browser example](examples/slack/README.md) after configuring the service.
The app uses native `/auth.test`; Slack business responses retain their native meaning.

## Development and documentation

```sh
npm run typecheck
npm run typecheck:example
npm run lint
npm run build
REDIS_SERVER=/absolute/path/to/redis-server npm test
```

The integrated tests start private temporary Postgres and Redis processes.
The full suite needs the Redis executable even though runtime Events are optional.

Start with [docs](docs/README.md) for setup, current contracts and the latest [offline HTML specification](docs/specification.html).
[specification.json](specification.json) lists only current supporting sources; [archives](archives/README.md) preserves superseded planning and review history.
Runtime code is in `src/`, browser example code in `examples/`, tests in `test/`, and documentation tooling in `scripts/`.

The prior application snapshot `5638d38d4ee39885a2a549382a9fdc7a22f822dc` records 85 passing integrated tests plus separately scoped synthetic browser evidence.
A later audit identified five test coverage gaps, not reproduced product defects; see [implementation evidence](docs/implementation.md#test-coverage-audit).
Initial cross-client silent-login hardening remains explicitly deferred.
Live Cloud/Server embedding, supported Server registration, Slack acceptance and deployment capacity/recovery are not established.
No deployment is claimed.
