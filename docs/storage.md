# Relational Storage

Storage gives a Tableau Data App a place to keep its own relational data.
A deployment enables it independently of native providers, Jobs and events.
Each workspace is one schema in the installation's dedicated Storage PostgreSQL database.
The same PostgreSQL server can host the core database and the Storage database.
Use one workspace per Data App and put its ID in app configuration.
Two workspaces can both have a `product` table.
The declared app ID and workbook are attribution, while access follows the verified Tableau identity and the workspace's sharing rules.

## Deploy

Use a fresh, private PostgreSQL 16 or later database.
Create a non-superuser login with `CREATEROLE` and make it the Storage database owner.
Connect to the server as a database administrator and run the following commands in `psql`.
The `\password` prompt keeps the provisioning password out of shell history and SQL text.
Use the actual names of the core database and its service login in the last two statements.

```sql
CREATE ROLE tdas_storage LOGIN CREATEROLE NOSUPERUSER NOCREATEDB NOREPLICATION NOBYPASSRLS;
\password tdas_storage
CREATE DATABASE tdas_storage OWNER tdas_storage;
REVOKE ALL ON DATABASE tdas_storage FROM PUBLIC;
REVOKE CONNECT ON DATABASE tdas FROM PUBLIC;
GRANT CONNECT ON DATABASE tdas TO tdas;
```

Restrict the Storage database network to the TDAS API, database operators and backup clients.
Use verified TLS and SCRAM authentication.
On a shared cluster, configure database privileges or ordered `pg_hba.conf` entries so the generated `w_…_model`, `w_…_reader` and `w_…_editor` logins can connect only to Storage.
Avoid adding executable extensions, foreign servers or ambient role grants to the dedicated database.
Keep PostgreSQL parameter logging disabled for Storage connections and restrict database log access.
TDAS sends a SCRAM verifier when creating a role and seals the generated password with the installation sealing key.

In the existing service environment, set `STORAGE_DATABASE_URL` to the dedicated database and provisioner.
Use the normal PostgreSQL URL form with a URL-encoded password and no query parameters.
Set `STORAGE_DATABASE_CA_CERT` to a PEM file path or PEM contents if the server needs a private CA.
Optionally set `STORAGE_WORKSPACE_CONNECTIONS` to the per-API replica workspace connection budget, which defaults to eight.
Run the initialization command once before enabling the API.
The command verifies the database owner and version, initializes the control schema and removes public database and schema grants.
It can be rerun with the same settings.

```sh
node --env-file=.env dist/main.js storage-init
node --env-file=.env dist/main.js api
```

Each API replica uses up to two control connections plus the configured workspace budget.
A workspace can use one connection each for its model, reader and editor roles while those roles are active.
The API lazily generates the appropriate GraphQL model and releases idle connections and cached schemas.
Account for every replica when sizing PostgreSQL.
Long or blocking SQL can use shared database resources even when workspaces are isolated by authority.
Monitor connection use, query duration, large tables and lock waiters in PostgreSQL.
The service applies bounded connection, lock and statement waits.
There are no per-app storage, table, column or row quotas.

Unset all `STORAGE_` settings to remove Storage routes and database connections when the API restarts.
Stored workspaces remain in the dedicated database.
If enabled settings are unusable, the operator readiness endpoint describes what to check and independent routes continue to serve.

## Author a private workspace

From a fresh project directory, fetch `GET /v1/discovery` on the service origin.
Resolve `cli.href` against that origin, verify the download against `cli.bytes` and `cli.sha256`, and install it with the command in `cli.install`.
Use its matching Node range and set up your system credential store for CLI sign-in.
When Storage is enabled, `publicServices` advertises the entry point and signed-in `services` reports whether this site allows creation.
`links.storageSdk` and `links.storageSdkTypes` locate the optional browser module and its declaration.

An explicitly named TDAS operator signs in with `tdas login`, finds the trusted site record ID with `tdas sites list`, and runs `tdas storage enable <siteId>`.
An ordinary Tableau user on that site can then use the same CLI as a viewer.
`--viewer` uses the ordinary Tableau session flow and keeps its credential separate from any operator credential.

```sh
TDAS=./node_modules/.bin/tdas
"$TDAS" login --viewer --service https://service.example
"$TDAS" discover --viewer --service https://service.example
"$TDAS" storage create --name Purchasing
"$TDAS" storage show
```

The CLI saves `tdas-storage.json` with the origin, workspace ID and PostgreSQL reader and editor role names, and creates `migrations/`.
Keep the SQL files next to the Data App code.
A repeated create from this directory recovers the same workspace if the response was lost.
The workspace starts private.

Save this model as `migrations/001.sql`.
The natural key and compound foreign-key relationship are application choices.

```sql
CREATE TABLE product (
  sku text PRIMARY KEY,
  title text NOT NULL,
  price numeric(12,2) NOT NULL CHECK (price >= 0)
);

CREATE TABLE purchase (
  purchase_id uuid PRIMARY KEY,
  submitted_by uuid NOT NULL DEFAULT tdas.actor_id()
);

CREATE TABLE purchase_line (
  purchase_id uuid NOT NULL REFERENCES purchase(purchase_id) ON DELETE CASCADE,
  line_no integer NOT NULL,
  sku text NOT NULL REFERENCES product(sku),
  qty integer NOT NULL CHECK (qty > 0),
  PRIMARY KEY (purchase_id, line_no)
);
CREATE INDEX ON purchase_line (sku);

CREATE VIEW line_total WITH (security_invoker = true) AS
SELECT l.purchase_id, l.line_no, l.qty * p.price AS amount
FROM purchase_line l JOIN product p ON p.sku = l.sku;
```

```sh
"$TDAS" storage migrate --file migrations/001.sql
"$TDAS" storage schema --output schema.graphql
"$TDAS" storage schema --describe
```

Save this generated mutation document as `create-product.graphql`.

```graphql
mutation AddProduct($input: ProductInput!) {
  createProduct(input: { product: $input }) {
    product { sku title price }
  }
}
```

```sh
"$TDAS" storage graphql --file create-product.graphql \
  --variables '{"input":{"sku":"pen","title":"Pen","price":"2.25"}}'
```

Read through `allProducts(first: 25)`, update through `updateProductBySku`, and delete through `deleteProductBySku`.
Inspect the exported schema for generated input names, cursors, pagination options, and reverse and forward foreign-key fields.
The built-in filters cover common equality predicates.
For more specialized filtering or a business operation, publish an invoker view or function as part of the model.
PostgreSQL `numeric` and `bigint` values use decimal strings in GraphQL.
UUID and date/time values use the generated scalar types and string values.
For arbitrary precision inside a JSON value, use strings because JSON numbers are decoded as JavaScript numbers.

For an atomic purchase submission, add the following function to `migrations/002.sql`.
Replace `"<editor-role>"` with the role shown by `tdas storage show` or in `tdas-storage.json`.
The SQL expands JSON into lines and relies on the foreign key and quantity constraint.
If the last line fails, both the header and all lines are rolled back.

```sql
CREATE FUNCTION submit_purchase(id uuid, items jsonb) RETURNS purchase
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE result purchase;
BEGIN
  IF jsonb_array_length(items) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A purchase needs at least one item';
  END IF;
  INSERT INTO purchase(purchase_id) VALUES (id) RETURNING * INTO result;
  INSERT INTO purchase_line(purchase_id, line_no, sku, qty)
  SELECT id, ordinality, item->>'sku', (item->>'qty')::int
  FROM jsonb_array_elements(items) WITH ORDINALITY AS t(item, ordinality);
  RETURN result;
END $$;
GRANT EXECUTE ON FUNCTION submit_purchase(uuid,jsonb) TO "<editor-role>";
```

Apply it and refresh the generated schema.
The generated mutation is `submitPurchase(input: {id: $id, items: $items}) { result { purchaseId submittedBy } }` with `UUID!` and `JSON!` variables.
Each GraphQL request may run multiple database transactions.
One invocation of the authored SQL function is the atomic unit for this operation.
After an ambiguous network failure, query the stable `purchase_id` before retrying.
If the operation needs exact replay, implement that with an app-owned unique request key and persisted result in the same SQL transaction.

## Share data and use it in an app

A workspace owner can share with the home Tableau site or named verified people from that site.
When both grant types apply, the caller receives the higher permission.
A recipient must already have signed in so TDAS has a stable identity record.
Run `tdas storage identities --username viewer@example.com` to resolve a username and use the returned identity ID as the grant subject.
Run `tdas storage show` for the current `accessVersion`, then save a JSON document such as this and run `tdas storage access --file sharing.json`.

```json
{
  "version": 0,
  "site": "read",
  "grants": [{"identityId":"91fa6787-b636-4eb9-abe7-96ecb812d28a","access":"edit"}]
}
```

Use `site: null` to remove site-wide sharing and omit people from `grants` to revoke their named access.
A stale access version conflicts.
New admissions check current workspace grants, Tableau site trust and the caller's session, including when a replica has a warm generated schema.

Use the app's existing signed-in SDK service and the optional Storage module served from the same origin.

```js
import { createService } from "https://service.example/v1/tools/sdk/index.js";
import { workspace } from "https://service.example/v1/tools/sdk/storage.js";

const service = createService({ origin: "https://service.example", appId: "purchasing" });
const data = workspace(service, workspaceId);

export async function products() {
  // Call after the app's normal Tableau sign-in or session restore.
  return data.graphql(`query Products($count: Int!) {
    allProducts(first: $count) { nodes { sku title price } }
  }`, { count: 25 });
}
```

The helper raises `StorageGraphQLError` for GraphQL errors, including errors in an HTTP 200 response.
It exposes the error list and any partial `data`.
A standard GraphQL client can instead send documents and variables using the existing service bearer transport.

## Roles and revisions

Each workspace has a scoped model login and separate non-owner reader and editor logins.
The verified caller's identity is set at the start of each database transaction and exposed through `tdas.actor_id()`.
Even an owner uses the editor login for GraphQL.
By default new tables and views grant readers `SELECT` and editors `SELECT`, `INSERT`, `UPDATE` and `DELETE`.
Editors receive access to the model's sequences by default.
New routines require an explicit `EXECUTE` grant.
Owners can narrow object grants and use row-level security with `tdas.actor_id()`.
Use invoker functions and views when callers' object permissions and row policies should apply.
An author can deliberately grant more power inside a workspace with privileged functions or broader grants on their own objects.
Write routines that avoid trusting caller-supplied values as identity.
Any app with the same verified person's session has that person's workspace rights.

An owner migration uses the workspace as the unqualified creation target and runs with only that workspace's model privileges.
The file and migration journal commit together.
The ID defaults to the filename stem and must contain 1 to 128 ASCII letters, digits, periods, underscores or hyphens, starting with a letter or digit.
Committed IDs replay only with the original revision predecessor and identical UTF-8 file contents.
A stale predecessor or altered committed file conflicts.
A failed migration leaves the previous revision intact.
The runner rejects transaction and session administration statements and protocol-level `COPY`.
Commands that require running outside a transaction, such as `CREATE INDEX CONCURRENTLY`, require a separate operator maintenance procedure.

`tdas storage query --file explore.sql --values '["pen"]'` binds parameters to a single read-only `SELECT`.
The owner model login can see owner-visible data, including rows ordinary viewers cannot read.
`tdas storage schema --describe` includes columns, defaults, keys, constraints, indexes, privileges and routines for an owner.
The schema export always reflects the requesting identity's GraphQL authority.
A new model revision may rename or remove GraphQL fields.
If model generation fails after a committed migration, `tdas storage schema --describe` still inspects the physical model.
Use the owner query and migration tools to diagnose and fix forward.
Refresh the client schema after a model-changed error and verify the outcome of any mutation before retrying it.

## Operations and recovery

Use `tdas storage status` for readiness, creator enablement, and workspace state.
`tdas storage disable <siteId>` stops new creations on that trusted site while existing workspaces keep serving.
The owner can archive or unarchive a workspace.
Operators can suspend, resume, retire or transfer a workspace without giving a browser operator access.
An ownership transfer keeps the workspace ID and revision and removes the former owner's implicit rights.
An independent explicit grant can still authorize the former owner.
Storage records creator settings, workspace actions and sharing changes in `storage_control.audit` in its database.
Retirement permanently closes admissions and retains a workspace ID and data for operator recovery.
To permanently remove an already-retired workspace's data, the operator runs `tdas storage purge <workspaceId> --confirm <workspaceId>`.
The purge waits for scoped transactions admitted by every API replica.
It refuses out-of-schema ownership or catalog dependencies that would require cascading into other objects.
A failed purge keeps the workspace retired and leaves its data intact.
A successful retry returns the original tombstone, including `purgedAt`.
Data previously backed up remains subject to the backup retention policy.

Back up Storage control records, migration journals, model objects, sequences, grants, row policies and data together.
A logical database dump requires cluster-global role definitions and memberships separately.
Keep the corresponding core identity bindings and sealing keys under the existing installation backup custody.
Keep every key needed to open Storage role credentials in `SEALING_KEYS`.
The core `tdas-admin reseal` command does not change Storage's dedicated database.
With a shared cluster, use a coordinated recovery point for core and Storage.
Restore into a private isolated target because workspace SQL routines are executable content.
Validate role mappings, previously revoked grants, sample rows and writes before reopening admissions.

## HTTP reference

Storage uses the existing Tableau viewer bearer header and installation operator guard.
Errors outside GraphQL execution use the TDAS error shape and `X-TDAS-Request-Id`.
GraphQL errors can contain safe SQLSTATE, constraint and field names without protected row values.

| Method and route | Purpose |
| --- | --- |
| `GET /v1/discovery` | Find the matched toolkit and signed-in Storage availability and actions. |
| `GET /v1/storage/workspaces` | List accessible workspaces. |
| `POST /v1/storage/workspaces` | Create private workspace with `label`, `creationKey` and optional `attribution`. |
| `GET /v1/storage/workspaces/:id` | Return one accessible workspace. |
| `PATCH /v1/storage/workspaces/:id` | Owner updates `label` or state `active` or `archived`. |
| `POST /v1/storage/workspaces/:id/query` | Owner submits `sql` and optional bound `values`. |
| `POST /v1/storage/workspaces/:id/migrations` | Owner submits `id`, `predecessor` and `sql`. |
| `GET /v1/storage/workspaces/:id/identities?username=…` | Resolve a home-site identity for owner-managed sharing. |
| `PUT /v1/storage/workspaces/:id/access` | Owner changes `version`, `site` and `grants`. |
| `GET /v1/storage/workspaces/:id/schema` | Export `revision` and `sdl`, plus physical `model` for owners. Request `?view=model` for owner-only inspection without GraphQL generation. |
| `POST /v1/storage/workspaces/:id/graphql` | Submit `query`, optional `variables` and `operationName`. |
| `GET /v1/admin/storage` | Storage readiness, creator configuration and workspace states. |
| `PUT /v1/admin/storage/sites/:siteId` | Enable or disable creation with `enabled`. |
| `PATCH /v1/admin/storage/workspaces/:id` | Set `state` to `active`, `suspended` or `retired`, or set a verified home-site `ownerId`. |
| `DELETE /v1/admin/storage/workspaces/:id` | Purge a retired workspace with `confirm` equal to its ID and retain its tombstone. |
