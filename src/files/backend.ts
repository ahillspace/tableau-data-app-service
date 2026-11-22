import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

export type ListedObject = {
  name: string;
  id: string | null;
  updated_at: string | null;
  created_at: string | null;
  last_accessed_at: string | null;
  metadata: { size?: number; contentType?: string; cacheControl?: string; etag?: string } | null;
};

/** The nine storage operations the Files HTTP service needs from any backend. */
export interface FilesBackend {
  close(): Promise<void>;
  createBucket(workspaceId: string, bucket: string): Promise<void>;
  bucketExists(workspaceId: string, bucket: string): Promise<boolean>;
  listBuckets(workspaceId: string): Promise<{ name: string }[]>;
  putObject(input: {
    key: string;
    body: Uint8Array | Buffer | Readable;
    contentLength?: number | undefined;
    contentType?: string | undefined;
    cacheControl?: string | undefined;
    ifNoneMatch?: boolean;
  }): Promise<{ etag?: string | undefined }>;
  getObject(key: string): Promise<{
    body: Readable;
    contentType?: string;
    cacheControl?: string;
    etag?: string;
  }>;
  deleteObjects(keys: string[]): Promise<void>;
  listObjects(
    prefix: string,
    options: { limit: number; offset: number; search?: string | undefined },
  ): Promise<ListedObject[]>;
  signedGetUrl(key: string, expiresIn: number): Promise<string>;
}

/** Object IDs are stable across backends and are not backend credentials. */
export function stableId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

/** One byte-order comparator for object keys and folder prefixes across all backends. */
export function compareKeys(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Signed Files links, on every backend, may not outlive one week. */
export const MAX_SIGNED_URL_SECONDS = 7 * 24 * 60 * 60;

export const WORKSPACE_ID_LENGTH = 36;
export const BUCKET_NAME_MAX_LENGTH = 128;
export const OBJECT_PATH_MAX_LENGTH = 1024;
export const FILES_OBJECT_PREFIX = "files/buckets";
export const FILES_MARKER_PREFIX = "files/_meta/buckets/";

/** The longest logical key the HTTP contract can produce, including prefix expansion. */
export const MAX_FILE_KEY_LENGTH =
  WORKSPACE_ID_LENGTH +
  1 +
  FILES_OBJECT_PREFIX.length +
  1 +
  BUCKET_NAME_MAX_LENGTH +
  1 +
  OBJECT_PATH_MAX_LENGTH;
