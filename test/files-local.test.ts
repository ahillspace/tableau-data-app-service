import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { MAX_SIGNED_URL_SECONDS, stableId } from "../src/files/backend.ts";
import { filesConfiguration } from "../src/files/config.ts";
import { LocalDownloads, LocalStore } from "../src/files/local.ts";
import { load, runApi } from "../src/main.ts";
import { ServiceError } from "../src/platform/errors.ts";
import { Log } from "../src/platform/log.ts";
import { Sealer } from "../src/sealing/sealer.ts";
import { installStorage } from "../src/storage/install.ts";
import { identifier, storagePool } from "../src/storage/postgres.ts";
import { ADMIN, WORKSPACES } from "../src/storage/service.ts";
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

const bootstrap = (publicOrigin: string, podOrigin: string) => ({
  publicOrigin,
  deployments: [{ id: DEPLOYMENT, kind: "tableau-cloud", podOrigin }],
  firstSite: { deploymentId: DEPLOYMENT, contentUrl: "alpha" },
  firstOperator: { deploymentId: DEPLOYMENT, siteContentUrl: "alpha", username: "op@example.com" },
});

const physicalDir = (root: string, key: string) =>
  join(root, `e.${createHash("sha256").update(key, "utf8").digest("hex")}`);

const logicalKey = (workspaceId: string, bucket: string, path: string) =>
  `${workspaceId}/files/buckets/${bucket}/${path}`;

test("Files local configuration selects one persistent root and rejects mixed settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tdas-files-local-config-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const selected = filesConfiguration({ FILES_BACKEND: "local", FILES_LOCAL_ROOT: root });
  assert.ok(selected && "backend" in selected);
  assert.equal(selected.backend, "local");
  assert.equal(selected.root, realpathSync(root));

  const inferred = filesConfiguration({ FILES_LOCAL_ROOT: root });
  assert.ok(inferred && "backend" in inferred);
  assert.equal(inferred.backend, "local");

  assert.equal(filesConfiguration({}), undefined);
  for (const [env, expected] of [
    [{ FILES_BACKEND: "local" }, /FILES_LOCAL_ROOT/],
    [{ FILES_BACKEND: "local", FILES_S3_BUCKET: "bucket" }, /FILES_S3_BUCKET/],
    [{ FILES_BACKEND: "s3", FILES_LOCAL_ROOT: root }, /FILES_LOCAL_ROOT/],
    [{ FILES_LOCAL_ROOT: root, FILES_GCS_BUCKET: "bucket" }, /cannot be mixed/],
  ] as const) {
    const bad = filesConfiguration({ ...env });
    assert.ok(bad && "reason" in bad);
    assert.match(bad.reason, expected);
  }

  const missing = filesConfiguration({
    FILES_BACKEND: "local",
    FILES_LOCAL_ROOT: join(root, "absent"),
  });
  assert.ok(missing && "reason" in missing);
  assert.match(missing.reason, /existing/);
  const file = join(root, "not-a-directory");
  await writeFile(file, "x");
  const notDirectory = filesConfiguration({ FILES_BACKEND: "local", FILES_LOCAL_ROOT: file });
  assert.ok(notDirectory && "reason" in notDirectory);
  assert.match(notDirectory.reason, /directory/);
});

test("Files local commits same-key creation atomically and preserves old bytes on aborted replacement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tdas-files-local-store-"));
  const keys = testKeys();
  const store = new LocalStore({
    root,
    downloads: new LocalDownloads(new Sealer(keys), "https://service.test"),
  });
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  const key = "workspace/files/buckets/assets/race.txt";
  const attempts = await Promise.allSettled(
    ["first", "second"].map((value) =>
      store.putObject({
        key,
        body: Buffer.from(value),
        contentType: "text/plain",
        ifNoneMatch: true,
      }),
    ),
  );
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  const conflict = attempts.find((result) => result.status === "rejected");
  assert.ok(conflict && conflict.status === "rejected");
  assert.ok(
    conflict.reason instanceof ServiceError && conflict.reason.code === "files-already-exists",
  );

  await store.putObject({ key, body: Buffer.from("original"), contentType: "text/plain" });
  class FailingStream extends Readable {
    #sent = false;
    _read(): void {
      if (!this.#sent) {
        this.#sent = true;
        this.push(Buffer.from("partial"));
      } else {
        this.destroy(new Error("simulated interrupted upload"));
      }
    }
  }
  await assert.rejects(
    store.putObject({ key, body: new FailingStream(), contentType: "text/plain" }),
  );
  const object = await store.getObject(key);
  const chunks: Buffer[] = [];
  for await (const chunk of object.body) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), "original");
  const names = await readdir(physicalDir(root, key));
  assert.equal(names.filter((name) => name.endsWith(".bin")).length, 1);
  assert.ok(!names.some((name) => name.endsWith(".ref")));
});

test("Files local mapping uses bounded physical names and keeps exact logical keys in metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tdas-files-local-mapping-"));
  const keys = testKeys();
  const store = new LocalStore({
    root,
    downloads: new LocalDownloads(new Sealer(keys), "https://service.test"),
  });
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const base = "workspace/files/buckets/assets/";
  const longName = `${"a".repeat(600)}.txt`;
  const unicodeName = "über/日本語/approbación 😀.txt";
  const entries: [string, string][] = [
    [`${base}${longName}`, "long"],
    [`${base}${unicodeName}`, "unicode"],
    [`${base}reports`, "file-plus-folder-file"],
    [`${base}reports/nested.txt`, "file-plus-folder-child"],
  ];
  for (const [key, body] of entries)
    await store.putObject({ key, body: Buffer.from(body), contentType: "text/plain" });

  const directories = (await readdir(root, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  assert.equal(directories.length, entries.length);
  for (const entry of directories) assert.match(entry.name, /^e\.[a-f0-9]{64}$/);
  for (const [key, body] of entries) {
    const ref = JSON.parse(
      await readFile(join(physicalDir(root, key), "_object.json"), "utf8"),
    ) as { key: string; size: number };
    assert.equal(ref.key, key);
    assert.equal(ref.size, Buffer.byteLength(body));
  }

  const direct = await store.listObjects(base, { limit: 100, offset: 0 });
  assert.deepEqual(
    direct.map((row) => row.name),
    [longName, "reports", "reports", "über"],
  );
  assert.deepEqual(
    direct.map((row) => row.id === null),
    [false, false, true, true],
  );
  const paged = await store.listObjects(base, { limit: 2, offset: 1 });
  assert.deepEqual(
    paged.map((row) => row.name),
    ["reports", "reports"],
  );
  const unicode = await store.listObjects(`${base}über/日本語/`, { limit: 10, offset: 0 });
  assert.deepEqual(
    unicode.map((row) => row.name),
    ["approbación 😀.txt"],
  );
  const nested = await store.listObjects(`${base}reports/`, { limit: 10, offset: 0 });
  assert.deepEqual(
    nested.map((row) => row.name),
    ["nested.txt"],
  );
});

test("Files local service supports the full HTTP and SDK flow against isolated PostgreSQL", {
  timeout: 120_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tdas-files-local-"));
  const core = await freshDatabase();
  const tableau = await new TableauStandIn().start();
  const identity = await identityHarness(core.db, tableau);
  const pools: ReturnType<typeof storagePool>[] = [];
  const runners: Awaited<ReturnType<typeof runApi>>[] = [];
  t.after(async () => {
    await Promise.all(runners.map((runner) => runner.stop().catch(() => {})));
    await Promise.all(pools.map((pool) => pool.end().catch(() => {})));
    await identity.close().catch(() => {});
    await tableau.close().catch(() => {});
    await core.close().catch(() => {});
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
  await installStorage(control);
  const keys = testKeys();
  const bootstrapPath = join(root, "bootstrap.json");
  await writeFile(bootstrapPath, JSON.stringify(bootstrap(SERVICE_ORIGIN, tableau.origin)));

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
        FILES_BACKEND: "local",
        FILES_LOCAL_ROOT: root,
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
  const author = await appSignIn(identity, ownerSignIn.cookie, "files-local-app");
  const editorSignIn = await tableauSignIn(identity, tableau, {
    userName: "editor@example.com",
    userId: "editor@example.com",
    siteContentUrl: "alpha",
    siteId: "site-a",
  });
  const editor = await appSignIn(identity, editorSignIn.cookie, "files-local-app");
  const readerSignIn = await tableauSignIn(identity, tableau, {
    userName: "reader@example.com",
    userId: "reader@example.com",
    siteContentUrl: "alpha",
    siteId: "site-a",
  });
  const reader = await appSignIn(identity, readerSignIn.cookie, "files-local-app");
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
    body: JSON.stringify({ label: "Local Files", creationKey: "local-files" }),
  });
  const workspaceId = created.body.workspace.id as string;
  const base = `/v1/storage/workspaces/${workspaceId}/files/buckets/assets`;
  const identityId = async (username: string) => {
    const found = await req(
      `${WORKSPACES}/${workspaceId}/identities?username=${encodeURIComponent(username)}`,
      author.bearer,
    );
    const identities = found.body.identities as { identityId: string }[];
    assert.equal(identities.length, 1);
    return identities[0]!.identityId;
  };
  await req(`${WORKSPACES}/${workspaceId}/access`, author.bearer, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: 0,
      site: null,
      grants: [
        { identityId: await identityId("editor@example.com"), access: "edit" },
        { identityId: await identityId("reader@example.com"), access: "read" },
      ],
    }),
  });
  await req(`/v1/storage/workspaces/${workspaceId}/files/buckets`, editor.bearer, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "editor-bucket" }),
  });
  await req(
    `/v1/storage/workspaces/${workspaceId}/files/buckets`,
    reader.bearer,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "reader-bucket" }),
    },
    403,
  );
  await req(`/v1/storage/workspaces/${workspaceId}/files/buckets`, author.bearer, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "assets" }),
  });

  const uploadPath = "reports/q1.csv";
  const payload = Buffer.from("alpha,beta\n1,2\n");
  const upload = await req(
    `${base}/objects?path=${encodeURIComponent(uploadPath)}&contentType=text/csv&cacheControl=120`,
    author.bearer,
    { method: "POST", body: payload },
  );
  assert.equal(upload.body.error, null);
  assert.equal(upload.body.data.path, uploadPath);
  assert.match(upload.body.data.id, /^[a-f0-9]{32}$/);

  await req(
    `${base}/objects?path=${encodeURIComponent(uploadPath)}`,
    author.bearer,
    { method: "POST", body: Buffer.from("duplicate") },
    400,
  );
  const overwritten = await req(
    `${base}/objects?path=${encodeURIComponent(uploadPath)}&upsert=true&contentType=text/csv&cacheControl=240`,
    author.bearer,
    { method: "POST", body: Buffer.from("replaced") },
  );
  assert.equal(overwritten.body.data.id, upload.body.data.id);

  const download = await fetch(`${origin}${base}/objects?path=${encodeURIComponent(uploadPath)}`, {
    headers: { "tableau-service-authorization": `Bearer ${author.bearer}` },
  });
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "replaced");
  assert.equal(download.headers.get("cache-control"), "no-store");
  assert.equal(download.headers.get("content-type"), "text/csv");
  assert.ok(download.headers.get("etag"));
  assert.ok(!download.headers.has("x-tdas-files-path"));

  const unicodePath = "reports/über/日本語/approbación 😀.txt";
  const unicodePayload = Buffer.from("unicode: ✓ 日本語");
  await req(
    `${base}/objects?path=${encodeURIComponent(unicodePath)}&contentType=text/plain`,
    author.bearer,
    { method: "POST", body: unicodePayload },
  );
  const unicodeDownload = await fetch(
    `${origin}${base}/objects?path=${encodeURIComponent(unicodePath)}`,
    { headers: { "tableau-service-authorization": `Bearer ${author.bearer}` } },
  );
  assert.equal(unicodeDownload.status, 200);
  assert.equal(await unicodeDownload.text(), unicodePayload.toString());
  const unicodeRef = JSON.parse(
    await readFile(
      join(physicalDir(root, logicalKey(workspaceId, "assets", unicodePath)), "_object.json"),
      "utf8",
    ),
  ) as { key: string };
  assert.equal(unicodeRef.key, logicalKey(workspaceId, "assets", unicodePath));

  const longPath = `reports/${"long-".repeat(80)}.txt`;
  const longPayload = Buffer.from("bounded physical name");
  await req(
    `${base}/objects?path=${encodeURIComponent(longPath)}&contentType=text/plain`,
    author.bearer,
    { method: "POST", body: longPayload },
  );
  const longDownload = await fetch(
    `${origin}${base}/objects?path=${encodeURIComponent(longPath)}`,
    { headers: { "tableau-service-authorization": `Bearer ${author.bearer}` } },
  );
  assert.equal(longDownload.status, 200);
  assert.equal(await longDownload.text(), longPayload.toString());
  const longRef = JSON.parse(
    await readFile(
      join(physicalDir(root, logicalKey(workspaceId, "assets", longPath)), "_object.json"),
      "utf8",
    ),
  ) as { key: string };
  assert.equal(longRef.key, logicalKey(workspaceId, "assets", longPath));
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) assert.match(entry.name, /^e\.[a-f0-9]{64}$/);
  }

  const interrupted = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from("partial"));
      controller.error(new Error("simulated interrupted HTTP upload"));
    },
  });
  await assert.rejects(
    fetch(`${origin}${base}/objects?path=${encodeURIComponent(uploadPath)}&upsert=true`, {
      method: "POST",
      headers: { "tableau-service-authorization": `Bearer ${author.bearer}` },
      body: interrupted,
      duplex: "half",
    } as RequestInit),
  );
  const preserved = await fetch(`${origin}${base}/objects?path=${encodeURIComponent(uploadPath)}`, {
    headers: { "tableau-service-authorization": `Bearer ${author.bearer}` },
  });
  assert.equal(preserved.status, 200);
  assert.equal(await preserved.text(), "replaced");

  const nested = await req(
    `${base}/objects?path=${encodeURIComponent("reports/archive/nested.bin")}&contentType=application/octet-stream`,
    author.bearer,
    { method: "POST", body: Buffer.from("nested") },
  );
  assert.equal(nested.body.error, null);
  const fileAndFolder = await req(
    `${base}/objects?path=reports&contentType=text/plain`,
    author.bearer,
    { method: "POST", body: Buffer.from("folder-name-file") },
  );
  assert.equal(fileAndFolder.body.error, null);

  const list = await req(`${base}/list`, author.bearer, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prefix: "reports/", limit: 100 }),
  });
  assert.equal(list.body.error, null);
  assert.ok(list.body.data.some((item: any) => item.name === "q1.csv"));
  assert.ok(list.body.data.some((item: any) => item.name === "archive" && item.id === null));
  const all = await req(`${base}/list`, author.bearer, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ limit: 100 }),
  });
  assert.ok(
    all.body.data.some((item: any) => item.name === "reports" && typeof item.id === "string"),
  );
  assert.ok(all.body.data.some((item: any) => item.name === "reports" && item.id === null));

  const search = await req(`${base}/list`, author.bearer, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prefix: "reports/archive/", search: "nested" }),
  });
  assert.deepEqual(
    search.body.data.map((item: any) => item.name),
    ["nested.bin"],
  );

  const concurrentPath = "reports/race.bin";
  const concurrent = await Promise.all(
    [0, 1].map((index) =>
      fetch(`${origin}${base}/objects?path=${encodeURIComponent(concurrentPath)}`, {
        method: "POST",
        headers: { "tableau-service-authorization": `Bearer ${author.bearer}` },
        body: Buffer.from(`race-${index}`),
      }),
    ),
  );
  assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 400]);

  const big = Buffer.alloc(2_000_000);
  for (let i = 0; i < big.length; i++) big[i] = i % 251;
  const hash = createHash("sha256").update(big).digest("hex");
  await req(
    `${base}/objects?path=${encodeURIComponent("reports/big.bin")}&contentType=application/octet-stream`,
    author.bearer,
    { method: "POST", body: big },
  );
  const bigDownload = await fetch(
    `${origin}${base}/objects?path=${encodeURIComponent("reports/big.bin")}`,
    { headers: { "tableau-service-authorization": `Bearer ${author.bearer}` } },
  );
  assert.equal(
    createHash("sha256")
      .update(Buffer.from(await bigDownload.arrayBuffer()))
      .digest("hex"),
    hash,
  );

  const { workspace } = await import("../src/sdk/storage.ts");
  const sdkService = {
    request: (path: string, init: RequestInit = {}) =>
      fetch(`${origin}${path}`, {
        ...init,
        headers: {
          ...(init.headers as any),
          "tableau-service-authorization": `Bearer ${author.bearer}`,
        },
      }),
  } as any;
  const files = workspace(sdkService, workspaceId).files;
  const sdkUpload = await files
    .from("assets")
    .upload("reports/sdk.txt", Buffer.from("sdk"), { contentType: "text/plain", upsert: true });
  assert.equal(sdkUpload.error, null);
  const sdkDownload = await files.from("assets").download("reports/sdk.txt");
  assert.equal(await (sdkDownload.data as Blob).text(), "sdk");

  const signed = await req(`${base}/sign`, author.bearer, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: uploadPath, expiresIn: 60 }),
  });
  const signedUrl = new URL(signed.body.data.signedUrl);
  assert.equal(signedUrl.origin, SERVICE_ORIGIN);
  signedUrl.protocol = "http:";
  signedUrl.host = `127.0.0.1:${runner.port}`;
  const bearer = await fetch(signedUrl);
  assert.equal(bearer.status, 200);
  assert.equal(await bearer.text(), "replaced");
  assert.equal(bearer.headers.get("content-type"), "application/octet-stream");
  assert.equal(bearer.headers.get("content-disposition"), 'attachment; filename="download"');
  assert.equal(bearer.headers.get("x-content-type-options"), "nosniff");
  assert.equal(bearer.headers.get("cache-control"), "no-store");
  assert.match(bearer.headers.get("content-security-policy") ?? "", /sandbox/);

  const limitStart = Date.now();
  const limited = await req(`${base}/sign`, author.bearer, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: uploadPath, expiresIn: MAX_SIGNED_URL_SECONDS }),
  });
  const limitEnd = Date.now();
  const limitedToken = new URL(limited.body.data.signedUrl).searchParams.get("token") ?? "";
  const limitedSealed = JSON.parse(Buffer.from(limitedToken, "base64url").toString("utf8"));
  const limitedGrant = JSON.parse(
    new Sealer(keys).open(
      "files-local-download",
      stableId(logicalKey(workspaceId, "assets", uploadPath)),
      limitedSealed,
    ),
  ) as { key: string; exp: number };
  assert.equal(limitedGrant.key, logicalKey(workspaceId, "assets", uploadPath));
  assert.ok(
    limitedGrant.exp >= limitStart + MAX_SIGNED_URL_SECONDS * 1000 &&
      limitedGrant.exp <= limitEnd + MAX_SIGNED_URL_SECONDS * 1000,
  );
  await req(
    `${base}/sign`,
    author.bearer,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: uploadPath, expiresIn: MAX_SIGNED_URL_SECONDS + 1 }),
    },
    400,
  );

  const unsafePath = "reports/unsafe.html";
  await req(
    `${base}/objects?path=${encodeURIComponent(unsafePath)}&contentType=text/html`,
    author.bearer,
    { method: "POST", body: Buffer.from("<script>alert(1)</script>") },
  );
  const unsafeSign = await req(`${base}/sign`, author.bearer, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: unsafePath, expiresIn: 60 }),
  });
  const unsafeUrl = new URL(unsafeSign.body.data.signedUrl);
  unsafeUrl.protocol = "http:";
  unsafeUrl.host = `127.0.0.1:${runner.port}`;
  const unsafe = await fetch(unsafeUrl);
  assert.equal(unsafe.status, 200);
  assert.equal(await unsafe.text(), "<script>alert(1)</script>");
  assert.equal(unsafe.headers.get("content-type"), "application/octet-stream");
  assert.match(unsafe.headers.get("content-security-policy") ?? "", /default-src 'none'/);

  const downloads = new LocalDownloads(new Sealer(keys), origin);
  const expired = new URL(downloads.sign(`${workspaceId}/files/buckets/assets/${uploadPath}`, -1));
  const expiredResponse = await fetch(expired);
  assert.equal(expiredResponse.status, 403);
  const forged = new URL(expired);
  forged.searchParams.set("token", forged.searchParams.get("token")?.slice(0, -2) ?? "bad");
  assert.equal((await fetch(forged)).status, 403);

  const removed = await req(`${base}/remove`, author.bearer, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths: [uploadPath] }),
  });
  assert.deepEqual(removed.body.data, [{ name: uploadPath }]);
  await req(`${base}/objects?path=${encodeURIComponent(uploadPath)}`, author.bearer, {}, 404);
  assert.equal((await fetch(signedUrl)).status, 404);

  const other = await req("/v1/storage/workspaces", author.bearer, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "Other", creationKey: "other-local" }),
  });
  const otherId = other.body.workspace.id as string;
  await req(`/v1/storage/workspaces/${otherId}/files/buckets`, author.bearer, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "assets" }),
  });
  await req(
    `/v1/storage/workspaces/${otherId}/files/buckets/assets/objects?path=${encodeURIComponent(uploadPath)}`,
    author.bearer,
    {},
    404,
  );
  const strangerSignIn = await tableauSignIn(identity, tableau, {
    userName: "viewer@example.com",
    userId: "viewer@example.com",
    siteContentUrl: "alpha",
    siteId: "site-a",
  });
  const stranger = await appSignIn(identity, strangerSignIn.cookie, "other-app");
  await req(
    `/v1/storage/workspaces/${workspaceId}/files/buckets/assets/objects?path=${encodeURIComponent("reports/big.bin")}`,
    stranger.bearer,
    {},
    404,
  );
});
