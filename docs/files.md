# Files

Files is an optional TDAS service for workspace-scoped file objects.
It reuses the existing Storage workspace authority, Tableau caller identity, and TDAS service discovery.

## Configuration

Files requires Storage to be configured and available.
Select exactly one backend with `FILES_BACKEND`, which accepts `s3` or `gcs`.
Mixing S3 and GCS settings is rejected.
Misconfiguration makes the Files service unavailable without stopping unrelated TDAS routes.
When Files is disabled, Storage workspaces and data remain unchanged.

### S3

Configure one private S3-compatible bucket and server-side credentials:

- `FILES_S3_ENDPOINT`
- `FILES_S3_REGION` (default `us-east-1`)
- `FILES_S3_BUCKET`
- `FILES_S3_ACCESS_KEY_ID`
- `FILES_S3_SECRET_ACCESS_KEY`
- `FILES_S3_SESSION_TOKEN` (optional)
- `FILES_S3_FORCE_PATH_STYLE` (default `true`)
- `FILES_S3_CA_CERT` (optional PEM or file path)

When no `FILES_BACKEND` is set, any `FILES_S3_*` setting selects S3.

### GCS

GCS uses a Google Cloud Storage bucket as the object store, and the TDAS installation can run on any host that reaches the XML API endpoint.
The bucket must already exist before Files is configured.
Create an HMAC key for a service account with read, write, list and delete grants on objects in that bucket.

Set `FILES_BACKEND=gcs` and the three required variables:

- `FILES_GCS_BUCKET`
- `FILES_GCS_ACCESS_KEY_ID`
- `FILES_GCS_SECRET_ACCESS_KEY`

The HMAC access ID is used exactly as supplied.
The endpoint is fixed to `https://storage.googleapis.com` and the region is fixed to `auto`.
GCS uses path-style requests and accepts no endpoint, region, session-token or CA setting.
When no `FILES_BACKEND` is set, any `FILES_GCS_*` setting selects GCS.

## Workspace model

Buckets are logical names inside a Storage workspace.
TDAS stores objects in the operator-configured private bucket under workspace-scoped keys.
Objects are not addressable across workspaces through TDAS routes.

Permissions follow the Storage workspace access model:

- owner: create buckets, upload, download, list, remove, sign
- editor: upload, download, list, remove, sign
- reader: download, list, sign

Workspace retirement and purge are governed by Storage.
This v1 slice enforces workspace authority on every Files route and stores objects under workspace-prefixed keys in the private bucket.
It does not yet delete object bytes during Storage workspace purge/retirement; operators should treat object cleanup as a lifecycle follow-up.
Issued presigned URLs expire independently by their `expiresIn` and are not revoked by TDAS workspace state changes.

## HTTP routes

All routes require `tableau-service-authorization: Bearer <session>`.

- `POST /v1/storage/workspaces/:id/files/buckets` body `{ "name": "assets" }`
- `GET /v1/storage/workspaces/:id/files/buckets`
- `POST /v1/storage/workspaces/:id/files/buckets/:bucket/objects?path=<path>&upsert=false&contentType=...&cacheControl=3600`
- `GET /v1/storage/workspaces/:id/files/buckets/:bucket/objects?path=<path>`
- `POST /v1/storage/workspaces/:id/files/buckets/:bucket/list` body `{ "prefix": "", "limit": 100, "offset": 0, "search": "" }`
- `POST /v1/storage/workspaces/:id/files/buckets/:bucket/remove` body `{ "paths": ["a.txt"] }`
- `POST /v1/storage/workspaces/:id/files/buckets/:bucket/sign` body `{ "path": "a.txt", "expiresIn": 60 }`

## Supabase-shaped SDK

The optional Storage SDK module is served at `/v1/tools/sdk/storage.js` with `/v1/tools/sdk/storage.d.ts`.
Because the Storage SDK includes Files types, also fetch `/v1/tools/sdk/files.d.ts` alongside the Storage declaration for out-of-repo typechecking.


```ts
import { createService } from "/v1/tools/sdk/index.js";
import { workspace } from "/v1/tools/sdk/storage.js";

const service = createService({
  appId: "example.data-app",
  origin: "https://service.example.com",
});

const files = workspace(service, workspaceId).files;
await files.createBucket("assets");
const bucket = files.from("assets");

await bucket.upload("reports/q1.csv", file, { upsert: false, contentType: "text/csv", cacheControl: "3600" });
await bucket.download("reports/q1.csv");
await bucket.list("reports/");
const signed = await bucket.createSignedUrl("reports/q1.csv", 60);
await bucket.remove(["reports/q1.csv"]);
```

Supported upload options are `upsert`, `contentType`, and `cacheControl`.
Default upload rejects an existing object; `upsert: true` replaces it.
The S3 path sends `If-None-Match: *` and the GCS path sends `x-goog-if-generation-match: 0` for no-upsert uploads.
Both backends map the provider conflict to TDAS `400 files-already-exists`.

Signed URLs are presigned S3 GET URLs. They expire by `expiresIn` and grant read access to the object key; callers should treat them as bearer links.

## Deviations

- Buckets are explicit TDAS logical buckets backed by markers in the private object store, not Supabase bucket management API parity.
- The SDK is exposed as `workspace(service, workspaceId).files.from(bucket)` from the existing Storage SDK module, keeping Files optional and workspace-scoped.
- Upload bodies are streamed from the request payload when `Content-Length` is known; unknown-length streaming bodies are not a supported v1 upload mode.
- Authenticated TDAS download responses use `Cache-Control: no-store` to avoid shared-cache leaks; object `cacheControl` is preserved on the stored object and signed S3 URLs.
- List uses S3 delimiter semantics and includes direct folder rows (`CommonPrefixes`) alongside direct object rows.
- Object IDs in responses are stable workspace/bucket/path-derived IDs; ETag is exposed in metadata when available.
