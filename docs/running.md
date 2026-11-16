# Running

How to install, configure and operate an installation.

## Requirements

- Node 26.
- Postgres 16 or later, reachable with TLS.
- Redis 7 or later, only for events.
- An HTTPS public origin for the service.
- A Tableau Cloud OAuth client registered for the service's `/tableau/callback`.

## Install

```sh
npm ci
npm run build
```

## Configure

Set the host [configuration](operations.md#configuration) and write a bootstrap file:

```json
{
  "deployments": [
    { "id": "cloud-west", "kind": "tableau-cloud", "podOrigin": "https://pod.online.tableau.com", "clientId": "…" }
  ],
  "firstSite": { "deploymentId": "cloud-west", "contentUrl": "example-site" },
  "firstOperator": { "deploymentId": "cloud-west", "siteContentUrl": "example-site", "username": "operator@example.com" }
}
```

The bootstrap file holds no secrets.

## Run

```sh
node dist/main.js migrate
node dist/main.js api
node dist/main.js worker
```

Each role reads the host settings from its environment; `node --env-file=.env dist/main.js api` loads them from a file.

## Operate

```sh
tdas login --service https://service.example
tdas definitions create slack-bot.json
tdas definitions secret slack-bot clientSecret     # opens a one-time secret link
tdas definitions connect slack-bot                 # shared OAuth connect
tdas definitions update slack-bot --audience add <site>
tdas definitions redefine slack-bot slack-bot.json
tdas definitions retire slack-bot
tdas sites add cloud-west other-site
tdas operators add cloud-west other-site someone@example.com
tdas apps
```

Host-local commands, run where the service runs:

```sh
tdas-admin operators add --deployment cloud-west --site example-site --user operator@example.com
tdas-admin reseal
```

## Test

```sh
npm test
```

Tests start their own Postgres and Redis from the developer's local installations on macOS or Linux, and stand in for Tableau and providers with local servers.
