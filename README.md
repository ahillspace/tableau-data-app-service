# Tableau Data App Service

An authenticated router between Tableau Data Apps and the external APIs they use.
An operator installs it once and adds connection definitions at runtime.
Viewers sign in with Tableau, and Data Apps reach each connected provider's native API through the service.
Durable Jobs and optional live events are included.

Built with TypeScript on Node 26, Fastify, Kysely and Postgres, with Redis only for events.

## Status

Every automated check in [verification](docs/verification.md) passes against real Postgres and Redis.
The service has not yet been run against a live Tableau Cloud site or a real Slack workspace; [verification](docs/verification.md#known-limitations) lists what that leaves unproven.

## Quick start

```sh
npm ci
npm run build
npm test
```

Copy [.env.example](.env.example) and write a bootstrap file as [running](docs/running.md) describes, then run the `migrate`, `api` and `worker` roles.
The browser SDK is built to `dist/sdk/index.js`, and [examples/slack](examples/slack/README.md) is a Data App that uses it.

## Documentation

Start with [docs](docs/README.md).
[specification.json](specification.json) lists the documentation sources, and [docs/specification.html](docs/specification.html) is the offline view generated from them.
