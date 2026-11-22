import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { link, mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SealedJson } from "../persistence/schema.ts";
import { ServiceError } from "../platform/errors.ts";
import type { Sealer } from "../sealing/sealer.ts";
import { compareKeys, type FilesBackend, type ListedObject, stableId } from "./backend.ts";

export const FILES_DOWNLOAD = "/v1/files/download";
const DOWNLOAD_PURPOSE = "files-local-download";
const BUCKETS_PREFIX = "files/_meta/buckets/";
const REF_NAME = "_object.json";
const PAYLOAD_PATTERN = /^[0-9a-f-]{36}\.bin$/;
const RECORD_PATTERN = /^[a-f0-9]{32}$/;
const PHYSICAL_PATTERN = /^e\.[a-f0-9]{64}$/;

type ObjectRef = {
  version: 1;
  key: string;
  payload: string;
  contentType: string;
  cacheControl?: string | undefined;
  etag: string;
  createdAt: string;
  updatedAt: string;
  size: number;
};

const isCode = (error: unknown, code: string) =>
  (error as NodeJS.ErrnoException | undefined)?.code === code;

function backendError(error: unknown, op: string): ServiceError {
  if (error instanceof ServiceError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown";
  return new ServiceError(502, "files-backend-error", `Files ${op} failed`, {
    fields: [{ path: "storage", rule: `local:${code}` }],
  });
}

function safeKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= 1024 &&
    !key.includes("\0") &&
    !key.startsWith("/") &&
    !key.includes("//") &&
    !key.split("/").includes("..")
  );
}

function parseRef(raw: string): ObjectRef | undefined {
  try {
    const value = JSON.parse(raw) as Partial<ObjectRef>;
    if (
      value.version !== 1 ||
      typeof value.key !== "string" ||
      !safeKey(value.key) ||
      typeof value.payload !== "string" ||
      !PAYLOAD_PATTERN.test(value.payload) ||
      typeof value.contentType !== "string" ||
      typeof value.etag !== "string" ||
      typeof value.createdAt !== "string" ||
      typeof value.updatedAt !== "string" ||
      typeof value.size !== "number" ||
      !Number.isFinite(value.size) ||
      value.size < 0 ||
      (value.cacheControl !== undefined && typeof value.cacheControl !== "string")
    )
      return undefined;
    return value as ObjectRef;
  } catch {
    return undefined;
  }
}

function readGrant(token: string): SealedJson | undefined {
  if (token.length === 0 || token.length > 4096) return undefined;
  const bytes = Buffer.from(token, "base64url");
  if (bytes.toString("base64url") !== token) return undefined;
  try {
    const value = JSON.parse(bytes.toString("utf8")) as Partial<SealedJson>;
    if (
      typeof value.keyId !== "string" ||
      typeof value.nonce !== "string" ||
      typeof value.ciphertext !== "string" ||
      typeof value.tag !== "string"
    )
      return undefined;
    return value as SealedJson;
  } catch {
    return undefined;
  }
}

/** Seals a local download grant under the installation's existing sealing key. */
export class LocalDownloads {
  readonly #sealer: Sealer;
  readonly #origin: string;

  constructor(sealer: Sealer, publicOrigin: string) {
    this.#sealer = sealer;
    this.#origin = publicOrigin;
  }

  sign(key: string, expiresIn: number): string {
    const recordId = stableId(key);
    const grant = JSON.stringify({ key, exp: Date.now() + expiresIn * 1000 });
    const sealed = this.#sealer.seal(DOWNLOAD_PURPOSE, recordId, grant);
    const token = Buffer.from(JSON.stringify(sealed)).toString("base64url");
    const url = new URL(`${FILES_DOWNLOAD}/${recordId}`, this.#origin);
    url.searchParams.set("token", token);
    return url.href;
  }

  /** The record ID comes from the URL path, so the binding is checked before decryption. */
  verify(recordId: string, token: string): string {
    const reject = () =>
      new ServiceError(
        403,
        "files-download-invalid",
        "The signed download link is invalid or expired",
      );
    if (!RECORD_PATTERN.test(recordId)) throw reject();
    const sealed = readGrant(token);
    if (!sealed) throw reject();
    let key: unknown;
    let exp: unknown;
    try {
      const grant = JSON.parse(this.#sealer.open(DOWNLOAD_PURPOSE, recordId, sealed)) as {
        key?: unknown;
        exp?: unknown;
      };
      key = grant.key;
      exp = grant.exp;
    } catch {
      throw reject();
    }
    if (
      typeof key !== "string" ||
      typeof exp !== "number" ||
      !Number.isFinite(exp) ||
      exp <= Date.now() ||
      !safeKey(key) ||
      stableId(key) !== recordId
    )
      throw reject();
    return key;
  }
}

/** Ordinary private files under one persistent root; one API instance per root. */
export class LocalStore implements FilesBackend {
  readonly #root: string;
  readonly #downloads: LocalDownloads;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(options: { root: string; downloads: LocalDownloads }) {
    this.#root = options.root;
    this.#downloads = options.downloads;
  }

  async close(): Promise<void> {}

  /** One fixed-length directory per logical key keeps physical names bounded. */
  #dirForKey(key: string): string {
    if (!safeKey(key)) throw new ServiceError(404, "files-not-found", "Object not found");
    return join(this.#root, `e.${createHash("sha256").update(key, "utf8").digest("hex")}`);
  }

  #bucketMarkerKey(workspaceId: string, bucket: string): string {
    return `${workspaceId}/${BUCKETS_PREFIX}${bucket}.json`;
  }

  /** Serializes the short read-open, publish and reclaim steps; streaming stays outside. */
  async #withKey<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => gate);
    this.#locks.set(key, chain);
    await previous;
    try {
      return await run();
    } finally {
      release();
      void chain.then(() => {
        if (this.#locks.get(key) === chain) this.#locks.delete(key);
      });
    }
  }

  async #readRefPath(path: string): Promise<ObjectRef | undefined> {
    try {
      return parseRef(await readFile(path, "utf8"));
    } catch (error) {
      if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR")) return undefined;
      throw backendError(error, "read");
    }
  }

  async #stage(
    key: string,
    body: Uint8Array | Buffer | Readable,
    contentType: string,
    cacheControl?: string | undefined,
  ): Promise<{ dir: string; payloadPath: string; ref: ObjectRef }> {
    const dir = this.#dirForKey(key);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const payload = `${randomUUID()}.bin`;
    const payloadPath = join(dir, payload);
    const hash = createHash("sha256");
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer | string, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(bytes);
        size += bytes.byteLength;
        callback(null, bytes);
      },
    });
    const source = body instanceof Readable ? body : Readable.from([Buffer.from(body)]);
    try {
      await pipeline(source, counter, createWriteStream(payloadPath, { flags: "wx", mode: 0o600 }));
    } catch (error) {
      await unlink(payloadPath).catch(() => {});
      throw backendError(error, "upload");
    }
    const etag = `"${hash.digest("hex")}"`;
    const now = new Date().toISOString();
    const ref: ObjectRef = {
      version: 1,
      key,
      payload,
      contentType,
      etag,
      createdAt: now,
      updatedAt: now,
      size,
      ...(cacheControl ? { cacheControl } : {}),
    };
    return { dir, payloadPath, ref };
  }

  async createBucket(workspaceId: string, bucket: string): Promise<void> {
    const key = this.#bucketMarkerKey(workspaceId, bucket);
    try {
      await this.putObject({
        key,
        body: Buffer.from(
          JSON.stringify({ bucket, workspaceId, createdAt: new Date().toISOString() }),
        ),
        contentType: "application/json",
        cacheControl: "no-store",
        ifNoneMatch: true,
      });
    } catch (error) {
      if (error instanceof ServiceError && error.code === "files-already-exists")
        throw new ServiceError(409, "files-bucket-already-exists", "The bucket already exists");
      throw error;
    }
  }

  async bucketExists(workspaceId: string, bucket: string): Promise<boolean> {
    return (
      (await this.#readRefPath(
        join(this.#dirForKey(this.#bucketMarkerKey(workspaceId, bucket)), REF_NAME),
      )) !== undefined
    );
  }

  async listBuckets(workspaceId: string): Promise<{ name: string }[]> {
    const prefix = `${workspaceId}/${BUCKETS_PREFIX}`;
    const refs = await this.#collect();
    return refs
      .map(({ key }) => key.slice(prefix.length))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5))
      .sort(compareKeys)
      .map((name) => ({ name }));
  }

  async putObject(input: {
    key: string;
    body: Uint8Array | Buffer | Readable;
    contentLength?: number | undefined;
    contentType?: string | undefined;
    cacheControl?: string | undefined;
    ifNoneMatch?: boolean;
  }): Promise<{ etag?: string | undefined }> {
    const staged = await this.#stage(
      input.key,
      input.body,
      input.contentType ?? "application/octet-stream",
      input.cacheControl,
    );
    const refPath = join(staged.dir, REF_NAME);
    const tempRef = join(staged.dir, `.${randomUUID()}.ref`);
    try {
      await writeFile(tempRef, JSON.stringify(staged.ref), { flag: "wx", mode: 0o600 });
      const committed = await this.#withKey(input.key, async () => {
        if (input.ifNoneMatch) {
          try {
            await link(tempRef, refPath);
          } catch (error) {
            if (isCode(error, "EEXIST"))
              throw new ServiceError(400, "files-already-exists", "The resource already exists");
            throw error;
          }
          return undefined;
        }
        const previous = await this.#readRefPath(refPath);
        await rename(tempRef, refPath);
        return previous?.payload;
      });
      if (input.ifNoneMatch) await unlink(tempRef).catch(() => {});
      else if (committed && committed !== staged.ref.payload)
        await unlink(join(staged.dir, committed)).catch(() => {});
      return { etag: staged.ref.etag };
    } catch (error) {
      await unlink(tempRef).catch(() => {});
      await unlink(staged.payloadPath).catch(() => {});
      throw backendError(error, "upload");
    }
  }

  async getObject(key: string): Promise<{
    body: Readable;
    contentType?: string;
    cacheControl?: string;
    etag?: string;
  }> {
    const dir = this.#dirForKey(key);
    const { ref, handle } = await this.#withKey(key, async () => {
      const found = await this.#readRefPath(join(dir, REF_NAME));
      if (!found) throw new ServiceError(404, "files-not-found", "Object not found");
      try {
        return { ref: found, handle: await open(join(dir, found.payload), "r") };
      } catch (error) {
        if (isCode(error, "ENOENT"))
          throw new ServiceError(404, "files-not-found", "Object not found");
        throw error;
      }
    });
    let body: Readable;
    try {
      body = handle.createReadStream();
    } catch (error) {
      await handle.close().catch(() => {});
      throw backendError(error, "download");
    }
    return {
      body,
      contentType: ref.contentType,
      ...(ref.cacheControl ? { cacheControl: ref.cacheControl } : {}),
      etag: ref.etag,
    };
  }

  async deleteObjects(keys: string[]): Promise<void> {
    for (const key of keys) {
      const dir = this.#dirForKey(key);
      await this.#withKey(key, async () => {
        const path = join(dir, REF_NAME);
        const ref = await this.#readRefPath(path);
        await unlink(path).catch((error: unknown) => {
          if (!isCode(error, "ENOENT")) throw error;
        });
        if (ref)
          await unlink(join(dir, ref.payload)).catch((error: unknown) => {
            if (!isCode(error, "ENOENT")) throw error;
          });
      });
    }
  }

  async #collect(): Promise<{ key: string; ref: ObjectRef }[]> {
    const found: { key: string; ref: ObjectRef }[] = [];
    let entries;
    try {
      entries = await readdir(this.#root, { withFileTypes: true });
    } catch (error) {
      if (!isCode(error, "ENOENT") && !isCode(error, "ENOTDIR")) throw error;
      return found;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !PHYSICAL_PATTERN.test(entry.name)) continue;
      const ref = await this.#readRefPath(join(this.#root, entry.name, REF_NAME));
      if (ref) found.push({ key: ref.key, ref });
    }
    return found;
  }

  async listObjects(
    prefix: string,
    options: { limit: number; offset: number; search?: string | undefined },
  ): Promise<ListedObject[]> {
    type Candidate = { sortKey: string; row: ListedObject };
    const candidates: Candidate[] = [];
    const folders = new Set<string>();
    const search = options.search?.toLowerCase();
    for (const { key, ref } of await this.#collect()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (!rest) continue;
      const end = rest.indexOf("/");
      const name = end < 0 ? rest : rest.slice(0, end);
      if (!name) continue;
      if (search && !name.toLowerCase().includes(search)) continue;
      if (end >= 0) {
        const folderKey = `${prefix}${name}/`;
        if (folders.has(folderKey)) continue;
        folders.add(folderKey);
        candidates.push({
          sortKey: folderKey,
          row: {
            name,
            id: null,
            updated_at: null,
            created_at: null,
            last_accessed_at: null,
            metadata: null,
          },
        });
      } else {
        candidates.push({
          sortKey: key,
          row: {
            name,
            id: stableId(key),
            updated_at: ref.updatedAt,
            created_at: ref.createdAt,
            last_accessed_at: ref.updatedAt,
            metadata: {
              size: ref.size,
              contentType: ref.contentType,
              ...(ref.cacheControl ? { cacheControl: ref.cacheControl } : {}),
              etag: ref.etag,
            },
          },
        });
      }
    }
    candidates.sort((a, b) => compareKeys(a.sortKey, b.sortKey));
    return candidates.slice(options.offset, options.offset + options.limit).map((c) => c.row);
  }

  async signedGetUrl(key: string, expiresIn: number): Promise<string> {
    return this.#downloads.sign(key, expiresIn);
  }
}
