# Persistence and operations

This document covers the data the service keeps, how it is stored, and how an installation runs.

## Stores

| Store | Holds | Required |
| --- | --- | --- |
| Postgres | Everything durable. | Yes. |
| Redis | Event fan-out only. | Only with events on. |
| Host secret | The sealing key. | Yes. |

## Tables

| Table | Owner | Holds |
| --- | --- | --- |
| `installation_revision` | Persistence | One counter. |
| `deployments` | Identity | Deployments from bootstrap. |
| `trusted_sites` | Identity | Site content URL, bound site ID, enabled. |
| `operators` | Identity | Named and bound operator identities. |
| `identities` | Identity | Identity, display name, last verified Tableau sign-in. |
| `sign_in_transactions` | Identity | Tableau sign-in state, PKCE verifier, nonce, expiry. |
| `sign_in_sessions` | Identity | Sign-in cookie hash, identity, expiry. |
| `restore_tokens` | Identity | Restore cookie hash, sign-in session, expiry. |
| `app_sign_ins` | Identity | App sign-in transaction, proof hash, completion code hash, expiry. |
| `app_sessions` | Identity | Bearer hash, kind (`app` or `operator`), identity, app ID, attribution, location, expiry. |
| `operator_sign_ins` | Identity | Operator sign-in transaction in loopback or popup mode, PKCE challenge, consent and code hashes. |
| `apps` | Identity | App registry. |
| `definitions` | Connections | Connection definitions. |
| `definition_secrets` | Connections | Sealed application client secrets, signing keys and inbound verification secrets with authority generations. |
| `connections` | Connections | Owner-bound sealed source credentials, derived tokens and credential generations. |
| `connect_transactions` | Connections | Provider OAuth state, PKCE verifier, definition generation. |
| `jobs` | Jobs | Jobs and inputs. |
| `job_results` | Jobs | Results, deleted on expiry. |
| `audit` | Persistence | Operator and recovery actions, with no secret values. |
| `metric_buckets` | Operations | Bounded cumulative minute snapshots keyed by process restart identity and finite dimensions. |
| `process_heartbeats` | Operations | API/worker start identity, last heartbeat and safe process observations. |
| `schema_migrations`, `schema_migrations_lock` | Persistence | Applied migrations and the migration lock. |

## Migrations

The complete undeployed product schema is defined directly in src/persistence/migrations/0001-initial.
Fresh installation is the proof target; there are no upgrade migrations, backfills, credential conversions or compatibility flags for earlier designs.
The `migrate` role runs pending migrations and exits; API and worker roles refuse to start when the schema is behind.

## Postgres TLS

The service connects to Postgres with TLS and verifies the server certificate.
The CA certificate is given through the `DATABASE_CA_CERT` setting, as inline PEM or a file path, when the server's certificate is not signed by a public CA.
There is no setting that turns verification off.

## Sealing key

The sealing key is a 256-bit key given to the process through the `SEALING_KEYS` setting, as JSON naming the current key ID and each key's base64 value:

```json
{ "current": "k1", "keys": { "k1": "<base64 of 32 bytes>" } }
```

Key IDs are 1 to 64 characters of letters, digits, `.`, `_` and `-`.
New values seal with the current key; old values open with their own key ID.
`tdas-admin reseal` reseals every value with the current key, after which old keys can be removed.
The sealing key is the one secret the host holds, and it seals no provider value in plain text anywhere else.
`tdas-admin reseal` runs while the service is up, after every process has the new current key.
It replaces each value with a compare-and-swap on the old sealed value, so a concurrent write is never overwritten, and finishes with a second pass that confirms no value still names an old key.
It exits with status 1 if any value still names an old key, and it is safe to rerun after an interruption.

Only secrets are sealed: application client secrets and signing keys, webhook verification secrets, owner credentials and cached derived tokens.
Job inputs, results and progress are app data and are stored as ordinary rows, covered by the database's own protection at rest.

## Maintenance

Every 60 seconds the worker recovers expired Job leases and deletes expired transactions, sessions, Job results and Job records in batches of 500.

## Health

`GET /health/live` reports the process is up.
`GET /health/ready` reports the database is reachable, the schema is current and, with events on, the event bus is connected; any failing check answers 503.
The worker role serves the same two routes on its own port, `WORKER_HEALTH_PORT`, and reports ready when the database is reachable and maintenance has run within the last three intervals plus 30 seconds.

## Telemetry maintenance

API and worker processes publish heartbeats every 15 seconds, with a unique ID per process start.
API collectors flush cumulative minute snapshots every 10 seconds, retrying identical sequence numbers idempotently.
The worker prunes metric data after seven days and stale process history after 24 hours.
No native request waits for a synchronous metric write.
[Metrics](metrics.md) defines counters, histogram merging, freshness, bounded buffers and crash loss.

## Backup

Ordinary Postgres backups apply.
Restoring an older backup loses the interval since the backup; sessions issued in that interval stop working and users sign in again.

## Configuration

Host configuration is limited to what the service cannot get any other way.
An empty value counts as unset.

| Setting | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Required | Postgres connection, `postgres://` or `postgresql://`. |
| `DATABASE_CA_CERT` | None | CA for Postgres, as inline PEM or a file path. |
| `SEALING_KEYS` | Required | [Sealing keys](#sealing-key). |
| `BOOTSTRAP` | Required | Path to the bootstrap file (see [identity](identity.md#bootstrap)). |
| `PUBLIC_ORIGIN` | From bootstrap | The service's own HTTPS origin; HTTP is allowed on loopback. When it is set in both places the two must match. |
| `CONSOLE_ENABLED` | false | Serve the optional same-origin operator console. |
| `REDIS_URL` | None | Redis for events, `redis://` or `rediss://`; events are off when unset. |
| `PORT` | 3000 | API role listening port. |
| `WORKER_HEALTH_PORT` | 3001 | Worker health routes port. |
| `SIGN_IN_LIMIT` | 604800 (7 days) | Seconds a Tableau sign-in lasts; overrides the bootstrap `signInLimit`. |
| `JOB_INPUT_CAP` | 104857600 (100 MiB) | Job input cap in bytes. |
| `JOB_RESULT_CAP` | 104857600 (100 MiB) | Job result cap in bytes. |
| `JOB_RUNTIME_CAP` | 86400 (24 hours) | Job runtime cap in seconds. |
| `JOB_RESULT_RETENTION` | 604800 (7 days) | Seconds a result is kept after the Job finishes. |
| `JOB_RECORD_RETENTION` | 2592000 (30 days) | Seconds a finished-Job record is kept. |
| `WORKER_CONCURRENCY` | 4 | Jobs each worker runs at once. |
| `UPSTREAM_CONNECT_TIMEOUT` | 10000 | Milliseconds to open an upstream connection. |
| `UPSTREAM_HEADERS_TIMEOUT` | 120000 | Milliseconds to wait for upstream response headers. |
| `UPSTREAM_IDLE_TIMEOUT` | 120000 | Milliseconds a stream may make no progress. |

Every setting is validated at startup, and a failure lists every bad field with its rule and no value.
