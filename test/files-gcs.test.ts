import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import { test } from "node:test";
import { filesConfiguration } from "../src/files/config.ts";
import { S3Store } from "../src/files/s3.ts";
import { ServiceError } from "../src/platform/errors.ts";

const accessKeyId = "GOOGSYNTHETICACCESSKEY";
const secretAccessKey = "synthetic-secret-only";
const gcsBucket = "tdas-gcs-synthetic";
const s3Bucket = "tdas-s3-synthetic";

type Seen = { method: string; path: string; headers: IncomingHttpHeaders };

const headerNames = (headers: IncomingHttpHeaders) =>
  Object.keys(headers).map((name) => name.toLowerCase());

const collect = async (body: Readable) => {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

async function localObjectStore() {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    seen.push({ method: request.method ?? "", path: request.url ?? "", headers: request.headers });
    request.resume();
    if (request.url?.includes("conflict")) {
      response.writeHead(412, { "content-type": "application/xml" });
      response.end(
        '<?xml version="1.0" encoding="UTF-8"?><Error><Code>PreconditionFailed</Code><Message>The resource already exists</Message></Error>',
      );
      return;
    }
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "text/plain", etag: '"synthetic-etag"' });
      response.end("synthetic-body");
      return;
    }
    response.writeHead(200, { etag: '"synthetic-etag"' });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local object store address");
  return {
    seen,
    endpoint: `http://127.0.0.1:${address.port}`,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

test("Files GCS protocol contract keeps S3 writes and presigning unchanged at the SDK boundary", async (t) => {
  const store = await localObjectStore();
  const gcs = new S3Store({
    backend: "gcs",
    endpoint: store.endpoint,
    region: "auto",
    bucket: gcsBucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: true,
  });
  const s3 = new S3Store({
    backend: "s3",
    endpoint: store.endpoint,
    region: "us-east-1",
    bucket: s3Bucket,
    accessKeyId: "SYNTHETICS3ACCESSKEY",
    secretAccessKey,
    forcePathStyle: true,
  });
  t.after(async () => {
    gcs.close();
    s3.close();
    await store.close();
  });

  store.seen.length = 0;
  await gcs.createBucket("workspace-a", "assets");
  const create = store.seen.at(-1);
  assert.ok(create);
  assert.equal(create.method, "PUT");
  assert.match(
    create.path,
    new RegExp(`^/${gcsBucket}/workspace-a/files/_meta/buckets/assets\\.json(?:\\?.*)?$`),
  );
  assert.equal(create.headers["x-goog-if-generation-match"], "0");
  assert.ok(!headerNames(create.headers).includes("if-none-match"));

  store.seen.length = 0;
  const createBody = Buffer.from("synthetic-body");
  await gcs.putObject({
    key: "objects/create-only.txt",
    body: Readable.from([createBody]),
    contentLength: createBody.byteLength,
    contentType: "text/plain",
    ifNoneMatch: true,
  });
  const createWrite = store.seen.at(-1);
  assert.ok(createWrite);
  assert.equal(createWrite.method, "PUT");
  assert.equal(createWrite.headers["x-goog-if-generation-match"], "0");
  assert.ok(!headerNames(createWrite.headers).includes("if-none-match"));
  const authorization = createWrite.headers.authorization ?? "";
  assert.match(authorization, /^AWS4-HMAC-SHA256 /);
  assert.match(authorization, new RegExp(`Credential=${accessKeyId}/[^,]*/auto/s3/aws4_request`));
  assert.match(authorization, /SignedHeaders=[^,]*x-goog-if-generation-match/);

  store.seen.length = 0;
  await gcs.putObject({ key: "objects/overwrite.txt", body: Buffer.from("replacement") });
  const overwrite = store.seen.at(-1);
  assert.ok(overwrite);
  assert.ok(!headerNames(overwrite.headers).includes("x-goog-if-generation-match"));
  assert.ok(!headerNames(overwrite.headers).includes("if-none-match"));

  store.seen.length = 0;
  await s3.putObject({
    key: "objects/s3-create-only.txt",
    body: Buffer.from("synthetic-body"),
    ifNoneMatch: true,
  });
  const s3Write = store.seen.at(-1);
  assert.ok(s3Write);
  assert.equal(s3Write.headers["if-none-match"], "*");
  assert.ok(!headerNames(s3Write.headers).some((name) => name.startsWith("x-goog-")));

  const signed = new URL(await gcs.signedGetUrl("objects/signed.txt", 60));
  assert.equal(signed.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.match(
    signed.searchParams.get("X-Amz-Credential") ?? "",
    new RegExp(`^${accessKeyId}/[^/]+/auto/s3/aws4_request$`),
  );
  assert.ok(
    !(signed.searchParams.get("X-Amz-SignedHeaders") ?? "").includes("x-goog-if-generation-match"),
  );
  store.seen.length = 0;
  const response = await fetch(signed);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "synthetic-body");
  const signedGet = store.seen.at(-1);
  assert.ok(signedGet);
  assert.equal(signedGet.method, "GET");
  assert.ok(!headerNames(signedGet.headers).includes("x-goog-if-generation-match"));
  assert.ok(!headerNames(signedGet.headers).includes("if-none-match"));

  await assert.rejects(
    gcs.putObject({
      key: "objects/conflict.txt",
      body: Buffer.from("synthetic-body"),
      ifNoneMatch: true,
    }),
    (error: unknown) =>
      error instanceof ServiceError &&
      error.status === 400 &&
      error.code === "files-already-exists",
  );
  await assert.rejects(
    gcs.createBucket("workspace-a", "conflict-bucket"),
    (error: unknown) =>
      error instanceof ServiceError &&
      error.status === 409 &&
      error.code === "files-bucket-already-exists",
  );
});

test("Files GCS configuration uses fixed Google settings and rejects mixed backends", () => {
  const gcs = filesConfiguration({
    FILES_BACKEND: "gcs",
    FILES_GCS_BUCKET: gcsBucket,
    FILES_GCS_ACCESS_KEY_ID: accessKeyId,
    FILES_GCS_SECRET_ACCESS_KEY: secretAccessKey,
  });
  assert.ok(gcs && "backend" in gcs);
  assert.equal(gcs.backend, "gcs");
  assert.equal(gcs.endpoint, "https://storage.googleapis.com");
  assert.equal(gcs.region, "auto");
  assert.equal(gcs.forcePathStyle, true);

  const dotted = filesConfiguration({
    FILES_GCS_BUCKET: "tdas_gcs.synthetic-bucket",
    FILES_GCS_ACCESS_KEY_ID: accessKeyId,
    FILES_GCS_SECRET_ACCESS_KEY: secretAccessKey,
  });
  assert.ok(dotted && "bucket" in dotted);
  assert.equal(dotted.bucket, "tdas_gcs.synthetic-bucket");

  const mixed = filesConfiguration({
    FILES_BACKEND: "gcs",
    FILES_S3_ENDPOINT: "https://s3.example.test",
    FILES_GCS_BUCKET: gcsBucket,
  });
  assert.ok(mixed && "reason" in mixed);
  assert.match(mixed.reason, /FILES_S3_ENDPOINT/);
  assert.ok(!mixed.reason.includes(secretAccessKey));
});

test("Files bucket marker checks use HEAD without stranding later S3 operations", async (t) => {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    seen.push({ method: request.method ?? "", path: request.url ?? "", headers: request.headers });
    const path = request.url ?? "";
    request.resume();
    const xml = (code: string) =>
      `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>synthetic</Message></Error>`;
    if (path.includes("forbidden")) {
      response.writeHead(403, { "content-type": "application/xml" });
      response.end(xml("AccessDenied"));
      return;
    }
    if (path.includes("missing")) {
      response.writeHead(404, { "content-type": "application/xml" });
      response.end(xml("NoSuchKey"));
      return;
    }
    if (request.method === "HEAD") {
      response.writeHead(200, { etag: '"marker-etag"' });
      response.end();
      return;
    }
    if (request.method === "GET") {
      response.writeHead(200, {
        "content-type": "text/plain",
        etag: '"object-etag"',
      });
      response.end("object-body");
      return;
    }
    if (request.method === "PUT") {
      response.writeHead(200, { etag: '"object-etag"' });
      response.end();
      return;
    }
    response.writeHead(405);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local object store address");
  const store = new S3Store({
    backend: "s3",
    endpoint: `http://127.0.0.1:${address.port}`,
    region: "us-east-1",
    bucket: "marker-bucket",
    accessKeyId,
    secretAccessKey,
    forcePathStyle: true,
  });
  t.after(async () => {
    store.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  assert.equal(await store.bucketExists("ws", "missing"), false);
  assert.equal(await store.bucketExists("ws", "assets"), true);
  await assert.rejects(
    store.bucketExists("ws", "forbidden"),
    (error: unknown) =>
      error instanceof ServiceError && error.status === 403 && error.code === "files-forbidden",
  );
  const markers = seen.filter((request) => request.path.includes("_meta/buckets"));
  assert.ok(markers.length >= 3);
  assert.ok(markers.every((request) => request.method === "HEAD"));

  const before = seen.length;
  for (let i = 0; i < 60; i++) assert.equal(await store.bucketExists("ws", `assets-${i}`), true);
  assert.ok(seen.length - before > 50);
  await store.putObject({ key: "objects/after-markers.txt", body: Buffer.from("object-body") });
  const object = await store.getObject("objects/after-markers.txt");
  assert.equal(await collect(object.body), "object-body");
  assert.ok(
    !seen
      .slice(before)
      .some((request) => request.method === "GET" && request.path.includes("_meta")),
  );
});

test("Files listing merges multi-page keys and folders in one stable byte order", async (t) => {
  const prefix = "ws/files/buckets/assets/";
  const seen: URL[] = [];
  const contents = (key: string, etag: string) =>
    `<Contents><Key>${key}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>&quot;${etag}&quot;</ETag><Size>1</Size><StorageClass>STANDARD</StorageClass></Contents>`;
  const folder = (key: string) => `<CommonPrefixes><Prefix>${key}</Prefix></CommonPrefixes>`;
  const page = (entries: string, truncated: boolean, next?: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>listing-bucket</Name><Prefix>${prefix}</Prefix><MaxKeys>100</MaxKeys><IsTruncated>${truncated}</IsTruncated>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}${entries}</ListBucketResult>`;
  const pages: Record<string, string> = {
    first: page(`${folder(`${prefix}z/`)}${contents(`${prefix}m.txt`, "m")}`, true, "second"),
    second: page(
      `${folder(`${prefix}A/`)}${folder(`${prefix}aa/`)}${contents(`${prefix}a.txt`, "a")}`,
      false,
    ),
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "", "http://local");
    seen.push(url);
    request.resume();
    response.writeHead(200, { "content-type": "application/xml" });
    response.end(pages[url.searchParams.get("continuation-token") ?? "first"] ?? pages.first);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local object store address");
  const store = new S3Store({
    backend: "s3",
    endpoint: `http://127.0.0.1:${address.port}`,
    region: "us-east-1",
    bucket: "listing-bucket",
    accessKeyId,
    secretAccessKey,
    forcePathStyle: true,
  });
  t.after(async () => {
    store.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  const rows = await store.listObjects(prefix, { limit: 3, offset: 1 });
  assert.deepEqual(
    rows.map((row) => row.name),
    ["a.txt", "aa", "m.txt"],
  );
  assert.deepEqual(
    rows.map((row) => row.id === null),
    [false, true, false],
  );
  assert.equal(seen.length, 2);
  for (const url of seen) {
    assert.equal(url.searchParams.get("list-type"), "2");
    assert.equal(url.searchParams.get("prefix"), prefix);
    assert.ok(Number(url.searchParams.get("max-keys")) <= 1000);
  }
});
