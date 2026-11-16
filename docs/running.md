# Running

How to install, configure and operate an installation.

## Prerequisites

- Node 26.13 or later within Node 26.
- Postgres 16 or later, reachable with TLS.
- Redis 7 or later, only for events.
- An HTTPS public origin for the service.
- A Tableau Cloud OAuth client registered with the redirect URL `{public origin}/tableau/callback`.

## Install

```sh
npm ci
npm run build
```

The build compiles the service to `dist/`, including the browser SDK at `dist/sdk/index.js`, and fails if the minified SDK reaches 15 KiB.

## Configure

Set the host [configuration](operations.md#configuration); [.env.example](../.env.example) lists every setting.
Write a bootstrap file:

```json
{
  "publicOrigin": "https://service.example",
  "deployments": [
    { "id": "cloud-west", "kind": "tableau-cloud", "podOrigin": "https://pod.online.tableau.com", "clientId": "…" }
  ],
  "firstSite": { "deploymentId": "cloud-west", "contentUrl": "example-site" },
  "firstOperator": { "deploymentId": "cloud-west", "siteContentUrl": "example-site", "username": "operator@example.com" }
}
```

Deployment IDs are slugs, `tableau-cloud` is the one kind, and pod origins are HTTPS.
`publicOrigin` may be left out when `PUBLIC_ORIGIN` is set, and `signInLimit` sets the sign-in limit in seconds.
The bootstrap file holds no secrets.

## Run

```sh
node dist/main.js migrate
node dist/main.js api
node dist/main.js worker
```

Each role reads the host settings from its environment; `node --env-file=.env dist/main.js api` loads them from a file.
Run `migrate` once per release before starting the other roles.

## Operate

The package is not published, so run the CLI from the checkout with `node dist/cli/tdas.js`, or put `tdas` and `tdas-admin` on the path with `npm link`.
`--service` defaults to `TDAS_SERVICE`, then to the service of the last login.
Wherever a command takes `<site>`, it accepts the trusted site's record ID or its content URL, when that names one site.
A definition file's `audience` takes record IDs, which `tdas sites list` shows.

```sh
tdas login --service https://service.example
tdas whoami
tdas sites list                                     # trusted site record IDs for audiences
tdas definitions create crm.json
tdas definitions secret crm clientSecret      # opens a one-time secret link
tdas definitions connect crm                  # shared OAuth connect
tdas definitions update crm --audience add example-site
tdas definitions redefine crm crm.json  # ends existing connections
tdas definitions retire crm                   # ends existing connections
tdas sites add cloud-west other-site
tdas operators add cloud-west other-site someone@example.com
tdas apps
```

| Command | Does |
| --- | --- |
| `login --service <origin>`, `logout`, `whoami` | Operator sign-in through the browser, sign-out, and the signed-in operator. |
| `definitions list`, `definitions show <id>` | Read definitions. |
| `definitions create <file.json>` | Create a definition. |
| `definitions secret <id> <field>` | Open a one-time secret link for `clientSecret`, `signingSecret` or `credential`. |
| `definitions connect <id>` | Shared OAuth connect in the browser. |
| `definitions update <id> [<changes.json>] [--audience add\|remove <site>] [--enable] [--disable]` | Change in place. |
| `definitions redefine <id> <file.json>`, `definitions retire <id>` | Redefine or retire; both end existing connections. |
| `connections list [--definition <id>] [--status <status>]`, `connections disconnect <connectionId>` | Read and end connections. |
| `sites list`, `sites add <deployment> <content-url>`, `sites enable\|disable\|remove <site>` | Manage trusted sites. |
| `operators list`, `operators add <deployment> <site-content-url> <username>`, `operators remove <operatorId>` | Manage operators. |
| `apps` | App registry. |
| `jobs list [--state <state>] [--handler <name>]`, `jobs cancel <jobId>` | Every Job. |
| `sessions revoke <deployment:siteId:userId>` | End every session for an identity. |
| `audit [--limit <n>] [--before <id>]` | Audit log. |

Host-local commands, run where the service runs with the same settings:

```sh
tdas-admin operators add --deployment cloud-west --site example-site --user operator@example.com
tdas-admin reseal
```

## Test

```sh
npm test
npm run lint
npm run typecheck
```

Tests start their own Postgres and Redis from the developer's local installations on macOS or Linux, and stand in for Tableau and providers with local servers.
They need `openssl`, Postgres (`initdb`, `postgres`, `pg_isready`, found through `pg_config` or on the path) and `redis-server` with `redis-cli`.
`TDAS_TEST_INITDB`, `TDAS_TEST_POSTGRES` and similar variables point at a binary that is elsewhere.
