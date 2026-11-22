# Running

How to install, configure and operate an installation.

## Prerequisites

- Node 26.13 or later within Node 26.
- Postgres 16 or later, reachable with TLS.
- Redis 7 or later, only for events.
- A dedicated PostgreSQL database, only for [Relational Storage](storage.md).
- An HTTPS public origin for the service, reachable from Tableau's sign-in service.

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
    { "id": "cloud-west", "kind": "tableau-cloud", "podOrigin": "https://pod.online.tableau.com" }
  ],
  "firstSite": { "deploymentId": "cloud-west", "contentUrl": "example-site" },
  "firstOperator": { "deploymentId": "cloud-west", "siteContentUrl": "example-site", "username": "operator@example.com" }
}
```

Deployment IDs are slugs, `tableau-cloud` is the one kind, and pod origins are HTTPS.
`publicOrigin` may be left out when `PUBLIC_ORIGIN` is set, and `signInLimit` sets the sign-in limit in seconds.
The bootstrap file holds no secrets.
Nothing is registered with Tableau in advance; see [Tableau client](identity.md#tableau-client).

## Run

```sh
node dist/main.js migrate
node dist/main.js api
node dist/main.js worker
```

Each role reads the host settings from its environment; `node --env-file=.env dist/main.js api` loads them from a file.
Run `migrate` once per release before starting the other roles.
For an opt-in Storage database, run `node dist/main.js storage-init` once before starting the API.
Follow the [Storage deployment instructions](storage.md#deploy) for the required database owner and grants.
For optional Files, select exactly one S3-compatible, GCS or persistent local backend and prepare its storage before the API starts; [Files configuration](files.md#configuration) lists the settings and deployment limits.

## Operate

Start at `https://<service>/v1/discovery` and resolve `cli.href` against that origin.
Download the CLI archive into a directory where you want to install the client, keeping the versioned filename.
Verify its size and SHA-256 against discovery, then run the command shown in `cli.install` from that directory.
The archive requires the Node range shown in discovery and access to the npm registry for its runtime keyring dependency.
Viewer and operator sign-in require a working system credential store, such as an unlocked Secret Service keyring on Linux.
Run `./node_modules/.bin/tdas --help` for command usage.
You can also run the CLI from the service checkout with `node dist/cli/tdas.js`.
The separate `tdas-admin` executable is available on the service host.
`--service` defaults to `TDAS_SERVICE`, then to the service of the last login.
Wherever a command takes `<site>`, it accepts the trusted site's record ID or its content URL, when that names one site.
A definition file's `audience` takes record IDs, which `tdas sites list` shows.

```sh
tdas discover --service https://service.example
tdas login --service https://service.example
tdas discover --operator
tdas whoami
tdas sites list                                     # trusted site record IDs for audiences
tdas definitions create crm.json
tdas definitions secret crm clientSecret      # hidden prompt on a TTY
tdas definitions connect crm                  # shared browser or machine setup
tdas definitions update crm --audience add example-site
tdas definitions redefine crm crm.json  # ends existing connections
tdas definitions retire crm                   # ends existing connections
tdas sites add cloud-west other-site
tdas operators add cloud-west other-site someone@example.com
tdas apps
```

| Command | Does |
| --- | --- |
| `discover --service <origin> [--operator or --viewer]` | Read public discovery or use a stored bearer for caller-specific details. |
| `login --service <origin>`, `logout`, `whoami` | Sign in through the browser, sign out, or inspect an operator identity. Add `--viewer` to use a separate viewer credential. |
| `definitions list`, `definitions show <id>` | Read definitions. |
| `definitions create <file.json>` | Create a definition. |
| `definitions secret <id> <field>` | Write clientSecret, signingSecret, signingPrivateKey or a shared credential using piped stdin, --from-file, hidden prompt or warned --value. |
| `definitions connect <id>` | Shared authorization_code setup in the browser, or synchronous local client_credentials setup with no browser. |
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

## Normal secret input

```sh
# Keep the input file outside the repository and use ordinary filesystem protection.
tdas definitions secret crm clientSecret --from-file ./client-secret.txt
tdas definitions secret models credential < ./service-account.json
tdas definitions secret crm signingSecret --clear
```

Piped stdin is the default input source when stdin is not a TTY.
With no explicit source on a TTY, the CLI prompts without echoing.
The --value option warns on stderr that shell history and process listings can expose the argument.
Conflicting sources fail before submission, including piped stdin plus an explicit source.
File and stdin input preserve multiline keys and JSON; no secret is printed on success or failure.
Blank input never clears a value; --clear explicitly clears it and cannot be combined with a value source.
The CLI fetches the safe version before mutation and reports a concurrent edit instead of silently overwriting it.
Create and update accept the same write-only API fields, but real secret-bearing files never belong in the repository.

## Console

Set CONSOLE_ENABLED=true to serve /console and the locally bundled assets on the API server.
Open /console, sign in through Tableau and approve operator access using the same grant and consent owner as tdas.
A Tableau administrator role alone grants no operator access.
Providers supports catalog/scratch setup, properties, edits, write-only rotation, shared browser or machine connect and retirement.
Status & analytics reads the same protected status, metric and audit JSON available to other operator tools.
Disabled events, unavailable dependencies, stale data and unknown observations are distinct.
The console stores no bearer in browser storage.
See [console](console.md) for cookie/CSRF requirements and [metrics](metrics.md) for count and latency meanings.

## Provider setup

Read the catalog with GET /v1/admin/catalog, copy a template's definition and supply its required public fields and audience site IDs.
Submit it through tdas definitions create or POST /v1/admin/definitions.
Set application secrets separately from shared connection credentials.
For service-account JSON, the selected catalog mapping imports only supported credential fields and verifies token_uri against the configured token endpoint.
Complete shared authorization_code setup with tdas definitions connect, or let each viewer connect a personal definition through the generic Data App interface.
Creating or redefining client_credentials with complete application prerequisites establishes initial local authorization unless credential is explicitly null.
If application secrets are supplied later, run tdas definitions connect after setting them.
Use the same command to reconnect after disconnect, a rejected grant or the configured reauthorization interval; ordinary edits and secret rotation never renew machine authorization.
Machine Connect confirms local setup without a browser or provider request, and exchanges lazily at checkout.
Static/JWT credentials are sealed through normal secret entry.
A missing optional webhook signingSecret affects ingress only, not native checkout.
[Catalog recipes](presets.md#native-request-recipes) demonstrate concrete multi-host selection, shared/personal use and streamed responses.

## Test

```sh
npm test
npm run lint
npm run typecheck
```

Tests start their own Postgres and Redis from the developer's local installations on macOS or Linux, and stand in for Tableau and providers with local servers.
They need `openssl`, Postgres (`initdb`, `postgres`, `pg_isready`, found through `pg_config` or on the path) and `redis-server` with `redis-cli`.
`TDAS_TEST_INITDB`, `TDAS_TEST_POSTGRES` and similar variables point at a binary that is elsewhere.
