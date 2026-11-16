# Persistence and operations

This document covers the data the service keeps, how it is stored, and how an installation runs.
Requirements come from [product](product.md).

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
| `app_sessions` | Identity | Bearer hash, identity, app ID, attribution, location, expiry. |
| `operator_sign_ins` | Identity | CLI sign-in transaction, loopback address, PKCE challenge, code hash. |
| `apps` | Identity | App registry. |
| `definitions` | Connections | Connection definitions. |
| `definition_secrets` | Connections | Sealed client and signing secrets. |
| `secret_links` | Connections | One-time secret link hashes. |
| `connections` | Connections | Connections and sealed credentials. |
| `connect_transactions` | Connections | Provider OAuth state, PKCE verifier, definition generation. |
| `jobs` | Jobs | Jobs and inputs. |
| `job_results` | Jobs | Results, deleted on expiry. |
| `audit` | Platform | Operator and recovery actions, with no secret values. |

## Migrations

One initial migration set creates the schema.
It does not upgrade databases created by earlier designs; such a database is recreated.
The `migrate` role runs pending migrations and exits; API and worker roles refuse to start when the schema is behind.

## Postgres TLS

The service connects to Postgres with TLS and verifies the server certificate.
The CA certificate is given through the `DATABASE_CA_CERT` setting when the server's certificate is not signed by a public CA.
There is no setting that turns verification off.

## Sealing key

The sealing key is a 256-bit key given to the process through the `SEALING_KEYS` setting, as key ID and base64 value pairs with one marked current.
New values seal with the current key; old values open with their own key ID.
`admin reseal` reseals every value with the current key, after which old keys can be removed.
The sealing key is the one secret the host holds, and it seals no provider value in plain text anywhere else.
`admin reseal` runs while the service is up, after every process has the new current key.
It replaces each value with a compare-and-swap on the old sealed value, so a concurrent write is never overwritten, and finishes with a second pass that confirms no value still names an old key.
It is safe to rerun after an interruption.

Only secrets are sealed: client secrets, signing secrets and credentials.
Job inputs, results and progress are app data and are stored as ordinary rows, covered by the database's own protection at rest.

## Maintenance

The worker deletes expired transactions, sessions, secret links, Job results and Job records in bounded batches.

## Health

`GET /health/live` reports the process is up.
`GET /health/ready` reports the database is reachable, the schema is current and, with events on, Redis is reachable for events.
The worker role serves the same two routes on its own port, `WORKER_HEALTH_PORT`, and reports ready when the database is reachable and its maintenance has run recently.

## Backup

Ordinary Postgres backups apply.
Restoring an older backup loses the interval since the backup; sessions issued in that interval stop working and users sign in again.

## Configuration

Host configuration is limited to what the service cannot get any other way.

| Setting | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection. |
| `DATABASE_CA_CERT` | CA for Postgres, when needed. |
| `SEALING_KEYS` | Sealing keys. |
| `PUBLIC_ORIGIN` | The service's own HTTPS origin. |
| `BOOTSTRAP` | Path to the bootstrap file (see [identity](identity.md#bootstrap)). |
| `REDIS_URL` | Redis for events; events are off when unset. |
| `PORT`, `WORKER_HEALTH_PORT` | Listening ports for the API role and for the worker's health routes. |
| `SIGN_IN_LIMIT`, `JOB_INPUT_CAP`, `JOB_RESULT_CAP`, `JOB_RUNTIME_CAP`, `JOB_RESULT_RETENTION`, `JOB_RECORD_RETENTION`, `WORKER_CONCURRENCY` | Limits with the defaults given in each component. |

Every setting is validated at startup, and a failure lists every bad field with its rule and no value.
