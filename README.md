# Tableau Data App Service

An authenticated router between Tableau Data Apps and the external APIs they use.
An operator installs it once and adds connection definitions at runtime.
Viewers sign in with Tableau, and Data Apps reach each connected provider's native API through the service.
Durable Jobs and optional live events are included.

Built with TypeScript on Node 26, Fastify, Kysely and Postgres, with Redis only for events.

## Status

The service is built against the specification, and every automated gate in [verification](docs/verification.md) passes.
The live gates against Tableau Cloud and a real Slack workspace have not been run.

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
[specification.json](specification.json) lists the specification sources, and [docs/specification.html](docs/specification.html) is the offline view generated from them.
[archives](archives/README.md) holds historical planning material and is never a source of requirements.
