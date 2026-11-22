# Files

Files is an optional TDAS service for workspace-scoped file objects.
It reuses the existing Storage workspace authority, Tableau caller identity, and TDAS service discovery.

## Configuration

Files requires Storage to be configured and available.
Select exactly one backend with `FILES_BACKEND`, which accepts `s3`, `gcs` or `local`.
Mixing S3, GCS and local settings is rejected.
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

### Local

Local Files stores ordinary private files in one persistent directory on the TDAS host or a mounted volume.
Set `FILES_BACKEND=local` and `FILES_LOCAL_ROOT` to an absolute directory path.
The directory must exist at startup and be readable, writable and traversable by the TDAS process.
When no `FILES_BACKEND` is set, `FILES_LOCAL_ROOT` selects local.
Mixing local settings with S3 or GCS settings is rejected.

Deploy one TDAS API instance against one local root because the short commit section that reclaims replaced files coordinates inside that process.
The local root must not be shared with another API replica or another service.
A Heroku dyno's local disk is ephemeral, so a Heroku deployment must use a persistent filesystem add-on or choose S3 or GCS instead.
Mount the persistent volume before the TDAS process starts.
Keep the directory owned by the service account and do not grant access to other users.
Back up the root with the volume's normal snapshot or file backup mechanism so payload files and their small reference files are restored together.
The on-disk layout is private to the implementation and has no archive format or user-serviceable files.

## Workspace model

Buckets are logical names inside a Storage workspace.
TDAS stores objects in the operator-configured private bucket under workspace-scoped keys.
Objects are not addressable across workspaces through TDAS routes.

Permissions follow the Storage workspace access model:

- owner: create buckets, upload, download, list, remove, sign
- editor: upload, download, list, remove, sign
- reader: download, list, sign

Workspace retirement and purge are governed by Storage.
This v1 slice enforces workspace authority on every Files route and stores objects under workspace-prefixed keys in the private bucket or local root.
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
S3 and GCS map the provider conflict to TDAS `400 files-already-exists`.
Local publishes a fully streamed file and its small reference with an atomic link for create-only uploads and an atomic rename for replacements.
A failed or interrupted local upload never replaces the old object.

S3 and GCS signed URLs are presigned GET URLs on their provider origins.
Local signed URLs are sealed bearer links on the TDAS public origin.
A local link carries an object-key-bound record ID and an expiry under a dedicated Files seal purpose, is issued only after workspace authorization, and needs no extra sign-in.
The link grants read access to exactly its file until expiry, and the bearer proof is not placed in log fields.
Local bearer responses are served as non-executable attachments with restrictive headers and `Cache-Control: no-store`.

## Deviations

- Buckets are explicit TDAS logical buckets backed by markers in the private object store or local root, not Supabase bucket management API parity.
- The SDK is exposed as `workspace(service, workspaceId).files.from(bucket)` from the existing Storage SDK module, keeping Files optional and workspace-scoped.
- S3 and GCS upload bodies are streamed from the request payload when `Content-Length` is known; unknown-length streaming bodies are not a supported v1 upload mode on those backends.
- Local uploads and downloads always stream through ordinary files and a small reference file, with no new runtime dependency.
- Authenticated TDAS download responses use `Cache-Control: no-store` to avoid shared-cache leaks; object `cacheControl` is preserved on the stored object and signed provider URLs.
- Local bearer downloads also use `Cache-Control: no-store`, because a cached response would outlive its expiry.
- List uses S3 delimiter semantics and includes direct folder rows alongside direct object rows; folder rows are named without a trailing slash.
- Object IDs in responses are stable workspace/bucket/path-derived IDs; ETag is exposed in metadata when available.
