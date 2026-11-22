import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { load, runApi } from "../src/main.ts";
import { Log } from "../src/platform/log.ts";
import { Sealer } from "../src/sealing/sealer.ts";
import { installStorage } from "../src/storage/install.ts";
import { identifier, storagePool } from "../src/storage/postgres.ts";
import { Registry } from "../src/storage/registry.ts";
import { ADMIN } from "../src/storage/service.ts";
import { caCert, freshDatabase, freshDatabaseUrl, sealingKeysEnv, testKeys } from "./support/db.ts";
import {
  appSignIn,
  DEPLOYMENT,
  identityHarness,
  operatorSignIn,
  SERVICE_ORIGIN,
  tableauSignIn,
} from "./support/identity.ts";
import { TableauStandIn } from "./support/tableau.ts";

const endpoint = process.env.TDAS_TEST_S3_ENDPOINT;
const bucket = process.env.TDAS_TEST_S3_BUCKET ?? "tdas-files-test";
const region = process.env.TDAS_TEST_S3_REGION ?? "us-east-1";
const accessKeyId = process.env.TDAS_TEST_S3_ACCESS_KEY_ID ?? "tdastestkey";
const secretAccessKey = process.env.TDAS_TEST_S3_SECRET_ACCESS_KEY ?? "tdassyntheticsecretonly";
const runS3 = !!endpoint;

const bootstrap = (podOrigin: string) => ({
  publicOrigin: SERVICE_ORIGIN,
  deployments: [{ id: DEPLOYMENT, kind: "tableau-cloud", podOrigin }],
  firstSite: { deploymentId: DEPLOYMENT, contentUrl: "alpha" },
  firstOperator: { deploymentId: DEPLOYMENT, siteContentUrl: "alpha", username: "op@example.com" },
});

async function s3() {
  return new S3Client({
    endpoint: endpoint as string,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
}

test("Files service supports Supabase-shaped workspace-scoped object operations over real S3", {
  timeout: 90_000,
  skip: !runS3 && "set TDAS_TEST_S3_ENDPOINT for real S3 integration",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tdas-files-"));
  const core = await freshDatabase();
  const tableau = await new TableauStandIn().start();
  const identity = await identityHarness(core.db, tableau);
  const pools: ReturnType<typeof storagePool>[] = [];
  const runners: Awaited<ReturnType<typeof runApi>>[] = [];
  const client = await s3();
  const prefix = `tdas-test-${randomUUID()}/`;
  t.after(async () => {
    await Promise.all(runners.map((r) => r.stop().catch(() => {})));
    await Promise.all(pools.map((p) => p.end().catch(() => {})));
    await identity.close().catch(() => {});
    await tableau.close().catch(() => {});
    await core.close().catch(() => {});
    client.destroy();
    await rm(root, { recursive: true, force: true });
  });

  const database = new URL(await freshDatabaseUrl());
  const databaseAdmin = storagePool(database.href, caCert(), 1);
  pools.push(databaseAdmin);
  const databaseName = identifier(decodeURIComponent(database.pathname.slice(1)));
  const provisioner = `s_${randomBytes(8).toString("hex")}`;
  await databaseAdmin.query(
    `create role ${provisioner} login createrole; alter database ${databaseName} owner to ${provisioner}`,
  );
  database.username = provisioner;
  database.password = "synthetic-storage-provisioner";
  const control = storagePool(database.href, caCert(), 1);
  pools.push(control);
  const keys = testKeys();
  const reg = new Registry(control, database, new Sealer(keys));
  await installStorage(control);
  const bootstrapPath = join(root, "bootstrap.json");
  await writeFile(bootstrapPath, JSON.stringify(bootstrap(tableau.origin)));

  const runner = await runApi(
    load(
      {
        BOOTSTRAP: bootstrapPath,
        DATABASE_URL: core.url,
        DATABASE_CA_CERT: caCert(),
        SEALING_KEYS: sealingKeysEnv(keys),
        PORT: "0",
        STORAGE_DATABASE_URL: database.href,
        STORAGE_DATABASE_CA_CERT: caCert(),
        STORAGE_WORKSPACE_CONNECTIONS: "2",
        FILES_S3_ENDPOINT: endpoint as string,
        FILES_S3_REGION: region,
        FILES_S3_BUCKET: bucket,
        FILES_S3_ACCESS_KEY_ID: accessKeyId,
        FILES_S3_SECRET_ACCESS_KEY: secretAccessKey,
        FILES_S3_FORCE_PATH_STYLE: "true",
      },
      new Log(() => {}),
    ),
  );
  runners.push(runner);
  const origin = `http://127.0.0.1:${runner.port}`;

  const ownerSignIn = await tableauSignIn(identity, tableau, {
    userName: "op@example.com",
    userId: "op@example.com",
    siteContentUrl: "alpha",
    siteId: "site-a",
  });
  const op = await operatorSignIn(identity, ownerSignIn.cookie);
  const author = await appSignIn(identity, ownerSignIn.cookie, "files-app");
  const site = await core.db.selectFrom("trusted_sites").select("id").executeTakeFirstOrThrow();
  const req = async (path: string, bearer: string, init: RequestInit = {}, status = 200) => {
    const response = await fetch(`${origin}${path}`, {
      ...init,
      headers: {
        "tableau-service-authorization": `Bearer ${bearer}`,
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : undefined;
    assert.equal(response.status, status, text.slice(0, 1000));
    return { response, body };
  };

  await req(`${ADMIN}/sites/${site.id}`, op.bearer, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  const created = await req("/v1/storage/workspaces", author.bearer, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "Files", creationKey: "files" }),
  });
  const workspaceId = created.body.workspace.id as string;
  const base = `/v1/storage/workspaces/${workspaceId}/files/buckets/assets`;
  await req(`/v1/storage/workspaces/${workspaceId}/files/buckets`, author.bearer, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "assets" }),
  });

  // upload
  const payload = Buffer.from(`hello ${prefix}`);
  const upload = await req(
    `${base}/objects?path=${encodeURIComponent(`${prefix}hello.txt`)}&contentType=text/plain&cacheControl=60`,
    author.bearer,
    {
      method: "POST",
      body: payload,
    },
  );
  assert.equal(upload.body.error, null);
  assert.equal(upload.body.data.path, `${prefix}hello.txt`);
  assert.equal(upload.body.data.fullPath, `assets/${prefix}hello.txt`);
  assert.match(upload.body.data.id, /^[a-f0-9]+$/);

  // default duplicate rejected
  await req(
    `${base}/objects?path=${encodeURIComponent(`${prefix}hello.txt`)}`,
    author.bearer,
    {
      method: "POST",
      body: Buffer.from("again"),
    },
    400,
  );

  // explicit upsert
  const upserted = await req(
    `${base}/objects?path=${encodeURIComponent(`${prefix}hello.txt`)}&upsert=true&cacheControl=120`,
    author.bearer,
    {
      method: "POST",
      body: Buffer.from("replaced"),
    },
  );

  // download
  const download = await fetch(
    `${origin}${base}/objects?path=${encodeURIComponent(`${prefix}hello.txt`)}`,
    {
      headers: { "tableau-service-authorization": `Bearer ${author.bearer}` },
    },
  );
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "replaced");
  assert.equal(download.headers.get("cache-control"), "no-store");

  // list
  const list = await req(`${base}/list`, author.bearer, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prefix }),
  });
  assert.equal(list.body.error, null);
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].name, `hello.txt`);
  assert.equal(list.body.data[0].id, upserted.body.data.id);

  // signed url
  const signed = await req(`${base}/sign`, author.bearer, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: `${prefix}hello.txt`, expiresIn: 60 }),
  });
  const signedRes = await fetch(signed.body.data.signedUrl);
  assert.equal(signedRes.status, 200);
  assert.equal(await signedRes.text(), "replaced");
  assert.match(signedRes.headers.get("cache-control") ?? "", /max-age=120/);

  // SDK shape: workspace(...).files.from(...)
  const { workspace } = await import("../src/sdk/storage.ts");
  const service = {
    request: (path: string, init: RequestInit = {}) =>
      fetch(`${origin}${path}`, {
        ...init,
        headers: {
          ...(init.headers as any),
          "tableau-service-authorization": `Bearer ${author.bearer}`,
        },
      }),
  } as any;
  const files = workspace(service, workspaceId).files;
  const createdBucket = await files.createBucket("sdk-bucket");
  assert.equal(createdBucket.error, null);
  const buckets = await files.listBuckets();
  assert.equal(buckets.error, null);
  assert.ok((buckets.data ?? []).some((b: any) => b.name === "sdk-bucket"));
  const sdkUpload = await files
    .from("assets")
    .upload(`${prefix}sdk.txt`, Buffer.from("sdk"), { contentType: "text/plain", upsert: true });
  assert.equal(sdkUpload.error, null);
  const sdkDownload = await files.from("assets").download(`${prefix}sdk.txt`);
  assert.equal(sdkDownload.error, null);
  assert.equal(await (sdkDownload.data as Blob).text(), "sdk");

  // remove
  const removed = await req(`${base}/remove`, author.bearer, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths: [`${prefix}hello.txt`] }),
  });
  assert.deepEqual(removed.body.data, [{ name: `${prefix}hello.txt` }]);
  await req(
    `${base}/objects?path=${encodeURIComponent(`${prefix}hello.txt`)}`,
    author.bearer,
    {},
    404,
  );

  // concurrent upload no-upsert across requests
  const concurrentPath = `${prefix}race.bin`;
  const results = await Promise.all(
    Array.from({ length: 2 }, (_, i) =>
      fetch(`${origin}${base}/objects?path=${encodeURIComponent(concurrentPath)}`, {
        method: "POST",
        headers: { "tableau-service-authorization": `Bearer ${author.bearer}` },
        body: Buffer.from(`race-${i}`),
      }),
    ),
  );
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 400]);

  // binary large upload over normal JSON cap, exact hash
  const big = Buffer.alloc(2_000_000);
  for (let i = 0; i < big.length; i++) big[i] = i % 251;
  const hash = createHash("sha256").update(big).digest("hex");
  await req(
    `${base}/objects?path=${encodeURIComponent(`${prefix}big.bin`)}&contentType=application/octet-stream`,
    author.bearer,
    {
      method: "POST",
      body: big,
    },
  );
  const bigDownload = await fetch(
    `${origin}${base}/objects?path=${encodeURIComponent(`${prefix}big.bin`)}`,
    {
      headers: { "tableau-service-authorization": `Bearer ${author.bearer}` },
    },
  );
  const got = Buffer.from(await bigDownload.arrayBuffer());
  assert.equal(createHash("sha256").update(got).digest("hex"), hash);

  // workspace isolation: other workspace cannot read
  const other = await req("/v1/storage/workspaces", author.bearer, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "Other", creationKey: "other" }),
  });
  const otherId = other.body.workspace.id as string;
  await req(
    `/v1/storage/workspaces/${otherId}/files/buckets/assets/objects?path=${encodeURIComponent(`${prefix}big.bin`)}`,
    author.bearer,
    {},
    404,
  );

  void reg;
  void client;
  void PutObjectCommand;
  void HeadObjectCommand;
  void DeleteObjectsCommand;
});
