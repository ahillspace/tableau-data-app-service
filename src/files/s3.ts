import { createHash } from "node:crypto";
import https from "node:https";
import { Readable } from "node:stream";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { ServiceError } from "../platform/errors.ts";
import type { FilesConfiguration } from "./config.ts";

export type ListedObject = {
  name: string;
  id: string | null;
  updated_at: string | null;
  created_at: string | null;
  last_accessed_at: string | null;
  metadata: { size?: number; contentType?: string; cacheControl?: string; etag?: string } | null;
};

function asServiceError(error: unknown, op: string): ServiceError {
  if (error instanceof ServiceError) return error;
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number }; Code?: string };
  const status = e.$metadata?.httpStatusCode;
  const code = e.name ?? e.Code ?? "";
  if (status === 404 || code === "NotFound" || code === "NoSuchKey")
    return new ServiceError(404, "files-not-found", "Object not found");
  if (status === 403 || code === "AccessDenied")
    return new ServiceError(403, "files-forbidden", "Files object access was denied");
  if (
    status === 412 ||
    status === 409 ||
    code === "PreconditionFailed" ||
    code === "ConditionalRequestConflict"
  )
    return new ServiceError(400, "files-already-exists", "The resource already exists");
  return new ServiceError(502, "files-backend-error", `Files ${op} failed`, {
    fields: [{ path: "storage", rule: `s3:${status ?? code ?? "unknown"}` }],
  });
}

export class S3Store {
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(config: Exclude<FilesConfiguration, { reason: string }>) {
    this.#bucket = config.bucket;
    const clientConfig: S3ClientConfig = {
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
      },
    };
    if (config.ca) {
      clientConfig.requestHandler = new NodeHttpHandler({
        httpsAgent: new https.Agent({ ca: config.ca }),
      });
    }
    this.#client = new S3Client(clientConfig);
  }

  async close(): Promise<void> {
    this.#client.destroy();
  }

  bucketMarkerKey(workspaceId: string, bucket: string): string {
    return `${workspaceId}/files/_meta/buckets/${bucket}.json`;
  }

  async createBucket(workspaceId: string, bucket: string): Promise<void> {
    const key = this.bucketMarkerKey(workspaceId, bucket);
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: Buffer.from(
            JSON.stringify({ bucket, workspaceId, createdAt: new Date().toISOString() }),
          ),
          ContentType: "application/json",
          IfNoneMatch: "*",
        }),
      );
    } catch (error) {
      const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === "PreconditionFailed" || e.$metadata?.httpStatusCode === 412)
        throw new ServiceError(409, "files-bucket-already-exists", "The bucket already exists");
      throw asServiceError(error, "createBucket");
    }
  }

  async bucketExists(workspaceId: string, bucket: string): Promise<boolean> {
    try {
      await this.#client.send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: this.bucketMarkerKey(workspaceId, bucket),
        }),
      );
      return true;
    } catch (error) {
      const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === "NoSuchKey" || e.name === "NotFound" || e.$metadata?.httpStatusCode === 404)
        return false;
      throw asServiceError(error, "bucket");
    }
  }

  async listBuckets(workspaceId: string): Promise<{ name: string }[]> {
    const prefix = `${workspaceId}/files/_meta/buckets/`;
    const buckets: { name: string }[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        }),
      );
      for (const item of response.Contents ?? []) {
        const key = item.Key ?? "";
        if (key.startsWith(prefix) && key.endsWith(".json")) {
          buckets.push({ name: key.slice(prefix.length, -5) });
        }
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
    buckets.sort((a, b) => a.name.localeCompare(b.name));
    return buckets;
  }

  async putObject(input: {
    key: string;
    body: Uint8Array | Buffer | Readable;
    contentLength?: number | undefined;
    contentType?: string | undefined;
    cacheControl?: string | undefined;
    ifNoneMatch?: boolean;
  }): Promise<{ etag?: string | undefined }> {
    try {
      const response = await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: input.key,
          Body: input.body,
          ...(input.contentLength !== undefined ? { ContentLength: input.contentLength } : {}),
          ...(input.contentType ? { ContentType: input.contentType } : {}),
          ...(input.cacheControl ? { CacheControl: input.cacheControl } : {}),
          ...(input.ifNoneMatch ? { IfNoneMatch: "*" } : {}),
        }),
      );
      return { etag: response.ETag ?? undefined };
    } catch (error) {
      throw asServiceError(error, "upload");
    }
  }

  async getObject(
    key: string,
  ): Promise<{ body: Readable; contentType?: string; cacheControl?: string; etag?: string }> {
    try {
      const response = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      const body = response.Body;
      if (!body) throw new ServiceError(404, "files-not-found", "Object not found");
      const stream =
        body instanceof Readable ? body : Readable.fromWeb(body.transformToWebStream() as any);
      return {
        body: stream,
        ...(response.ContentType ? { contentType: response.ContentType } : {}),
        ...(response.CacheControl ? { cacheControl: response.CacheControl } : {}),
        ...(response.ETag ? { etag: response.ETag } : {}),
      };
    } catch (error) {
      throw asServiceError(error, "download");
    }
  }

  async deleteObjects(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      for (let i = 0; i < keys.length; i += 1000) {
        const chunk = keys.slice(i, i + 1000);
        const response = await this.#client.send(
          new DeleteObjectsCommand({
            Bucket: this.#bucket,
            Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: false },
          }),
        );
        const errors = response.Errors ?? [];
        if (errors.length > 0) {
          throw new ServiceError(502, "files-backend-error", "Files remove failed", {
            fields: errors.map((e) => ({
              path: e.Key ?? "storage",
              rule: `s3:${e.Code ?? e.Message ?? "delete-error"}`,
            })),
          });
        }
      }
    } catch (error) {
      throw asServiceError(error, "remove");
    }
  }

  async listObjects(
    prefix: string,
    options: { limit: number; offset: number; search?: string | undefined },
  ): Promise<ListedObject[]> {
    try {
      const wanted = options.offset + options.limit;
      const collected: ListedObject[] = [];
      let continuationToken: string | undefined;
      while (collected.length < wanted) {
        const response = await this.#client.send(
          new ListObjectsV2Command({
            Bucket: this.#bucket,
            Prefix: prefix,
            Delimiter: "/",
            ContinuationToken: continuationToken,
            MaxKeys: 1000,
          }),
        );
        for (const cp of response.CommonPrefixes ?? []) {
          const p = cp.Prefix ?? "";
          if (!p.startsWith(prefix)) continue;
          const rest = p.slice(prefix.length);
          const name = rest.endsWith("/") ? rest.slice(0, -1) : rest;
          if (!name) continue;
          if (options.search && !name.toLowerCase().includes(options.search.toLowerCase()))
            continue;
          collected.push({
            name,
            id: null,
            updated_at: null,
            created_at: null,
            last_accessed_at: null,
            metadata: null,
          });
        }
        for (const item of response.Contents ?? []) {
          const key = item.Key ?? "";
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          if (!rest || rest.includes("/")) continue;
          if (options.search && !rest.toLowerCase().includes(options.search.toLowerCase()))
            continue;
          const lastModified = item.LastModified?.toISOString() ?? null;
          collected.push({
            name: rest,
            id: createHash("sha256").update(key).digest("hex").slice(0, 32),
            updated_at: lastModified,
            created_at: lastModified,
            last_accessed_at: lastModified,
            metadata: {
              ...(item.Size !== undefined ? { size: item.Size } : {}),
              ...(item.ETag ? { etag: item.ETag } : {}),
            },
          });
          if (collected.length >= wanted) break;
        }
        if (!response.IsTruncated || !response.NextContinuationToken) break;
        continuationToken = response.NextContinuationToken;
      }
      collected.sort((a, b) => a.name.localeCompare(b.name));
      return collected.slice(options.offset, options.offset + options.limit);
    } catch (error) {
      throw asServiceError(error, "list");
    }
  }

  async signedGetUrl(key: string, expiresIn: number): Promise<string> {
    try {
      return await getSignedUrl(
        this.#client,
        new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
        {
          expiresIn,
        },
      );
    } catch (error) {
      throw asServiceError(error, "sign");
    }
  }
}
