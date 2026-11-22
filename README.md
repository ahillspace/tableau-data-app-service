# Tableau Data App Service

An authenticated router between Tableau Data Apps and the external APIs they use.
An operator installs it once and adds connection definitions at runtime.
Viewers sign in with Tableau, and Data Apps reach each connected provider's native API through the service.
Durable Jobs, optional live events, and optional Relational Storage and Files workspaces are included.

Built with TypeScript on Node 26, Fastify, Kysely and Postgres, with Redis only for events.

## Status

The automated suite exercises synthetic Tableau/provider servers with real Postgres and Redis.
The optional same-server operator console is disabled by default; set CONSOLE_ENABLED=true to enable its Providers and Status & analytics tabs.
[Verification](docs/verification.md) records the integrated checks and separates synthetic evidence from live acceptance.
The service has not yet been run against a live Tableau Cloud site or real provider accounts; [verification](docs/verification.md#known-limitations) lists what that leaves unproven.

## Quick start

```sh
npm ci
npm run build
npm test
```

Copy [.env.example](.env.example) and write a bootstrap file as [running](docs/running.md) describes, then run the `migrate`, `api` and `worker` roles.
From an API installation, open `/v1/discovery` to get the matching CLI, browser SDK and sign-in guidance.
The browser SDK is built to `dist/sdk/index.js`, and [examples](examples/) holds Data Apps that use it.

## Documentation

Start with [docs](docs/README.md).
[specification.json](specification.json) lists the documentation sources, and [docs/specification.html](docs/specification.html) is the offline view generated from them.

This project is open source, is not affiliated with Tableau or Salesforce, and has no monetization plans.
