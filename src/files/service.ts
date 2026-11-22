import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ServiceDeployment, ServiceDiscovery, ServiceGuards } from "../http/services.ts";
import type { Principal } from "../identity/types.ts";
import { invalid, ServiceError } from "../platform/errors.ts";
import { fieldErrors } from "../platform/validation.ts";
import type { Sealer } from "../sealing/sealer.ts";
import { requireActive, type Workspace } from "../storage/registry.ts";
import { type FilesBackend, MAX_SIGNED_URL_SECONDS, stableId } from "./backend.ts";
import type { FilesConfiguration } from "./config.ts";
import { FILES_DOWNLOAD, LocalDownloads, LocalStore } from "./local.ts";
import { S3Store } from "./s3.ts";

export const FILES = "/v1/storage/workspaces";
const CONTRACT = "/v1/tools/specification.html#documents/files";
const BUCKETS_PREFIX = "files/buckets";
const uuid = z.uuid();

export interface FilesWorkspaceAuthority {
  find(principal: Principal, id: string): Promise<Workspace>;
  list(principal: Principal): Promise<Workspace[]>;
}

const id = (value: unknown) => {
  const parsed = uuid.safeParse(value);
  if (!parsed.success)
    throw new ServiceError(404, "storage-workspace-not-found", "No accessible storage workspace");
  return parsed.data;
};
const bucketName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/);
const objectPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (v) =>
      !v.includes("\0") && !v.startsWith("/") && !v.includes("//") && !v.split("/").includes(".."),
  );
const uploadOptions = z
  .object({
    upsert: z.union([z.boolean(), z.string()]).optional(),
    contentType: z.string().optional(),
    cacheControl: z.union([z.string(), z.number()]).optional(),
  })
  .partial();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid(fieldErrors(result.error));
  return result.data;
}

function handle(
  guard: (request: FastifyRequest) => Promise<Principal>,
  run: (request: FastifyRequest, reply: FastifyReply, principal: Principal) => unknown,
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("x-tdas-request-id", request.id);
    const principal = await guard(request);
    try {
      return await run(request, reply, principal);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(503, "files-unavailable", "Files could not complete the request.");
    }
  };
}

function bucketObjectKey(workspaceId: string, bucket: string, path: string): string {
  return `${workspaceId}/${BUCKETS_PREFIX}/${bucket}/${path}`;
}
function bucketPrefix(workspaceId: string, bucket: string, prefix = ""): string {
  const base = `${workspaceId}/${BUCKETS_PREFIX}/${bucket}/`;
  return prefix ? `${base}${prefix.replace(/^\/+/, "")}` : base;
}
function canWrite(access: Workspace["access"]): boolean {
  return access === "owner" || access === "edit";
}
function normalizeCacheControl(value: string | number | undefined): string {
  if (value === undefined) return "max-age=3600";
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) return `max-age=${raw}`;
  return raw;
}
function uploadBody(request: FastifyRequest): { body: Readable; contentLength?: number } {
  const body = request.body as unknown;
  if (body && typeof (body as any).pipe === "function") {
    const raw = request.headers["content-length"];
    const n = typeof raw === "string" ? Number(raw) : Array.isArray(raw) ? Number(raw[0]) : NaN;
    return Number.isFinite(n) && n >= 0
      ? { body: body as any, contentLength: n }
      : { body: body as any };
  }
  if (Buffer.isBuffer(body)) return { body: Readable.from(body), contentLength: body.byteLength };
  if (body instanceof Uint8Array) {
    const b = Buffer.from(body);
    return { body: Readable.from(b), contentLength: b.byteLength };
  }
  if (typeof body === "string") {
    const b = Buffer.from(body);
    return { body: Readable.from(b), contentLength: b.byteLength };
  }
  throw invalid([{ path: "body", rule: "bytes" }]);
}

export class Files {
  readonly #authority: FilesWorkspaceAuthority;
  readonly #store: FilesBackend;
  readonly #downloads: LocalDownloads | undefined;
  constructor(
    authority: FilesWorkspaceAuthority,
    store: FilesBackend,
    downloads?: LocalDownloads | undefined,
  ) {
    this.#authority = authority;
    this.#store = store;
    this.#downloads = downloads;
  }

  async discover(principal: Principal): Promise<ServiceDiscovery> {
    try {
      const workspaces = await this.#authority.list(principal);
      return {
        state: "available",
        actions: workspaces.length ? [{ method: "GET", href: FILES }] : [],
      };
    } catch {
      return { state: "unavailable", reason: "files-unavailable" };
    }
  }

  async #admitted(principal: Principal, workspaceId: unknown, write: boolean): Promise<Workspace> {
    const w = await this.#authority.find(principal, id(workspaceId));
    requireActive(w);
    if (write && !canWrite(w.access))
      throw new ServiceError(403, "files-forbidden", "Workspace edit access is required");
    return w;
  }

  async #bucket(
    principal: Principal,
    workspaceId: unknown,
    bucket: string,
    write: boolean,
  ): Promise<Workspace> {
    const w = await this.#admitted(principal, workspaceId, write);
    if (!(await this.#store.bucketExists(w.id, bucket)))
      throw new ServiceError(404, "files-bucket-not-found", "Bucket not found");
    return w;
  }

  routes(app: FastifyInstance, guards: ServiceGuards) {
    const caller = (run: Parameters<typeof handle>[1]) => handle(guards.requireCaller, run);
    const byWorkspace = `${FILES}/:id/files`;

    const downloads = this.#downloads;
    if (downloads) {
      app.get(`${FILES_DOWNLOAD}/:recordId`, async (request, reply) => {
        reply.header("x-tdas-request-id", request.id);
        try {
          const { recordId } = request.params as { recordId: string };
          const token = (request.query as { token?: unknown }).token;
          if (typeof token !== "string")
            throw new ServiceError(
              403,
              "files-download-invalid",
              "The signed download link is invalid or expired",
            );
          const key = downloads.verify(recordId, token);
          const object = await this.#store.getObject(key);
          reply.header("content-type", "application/octet-stream");
          reply.header("content-disposition", 'attachment; filename="download"');
          reply.header("x-content-type-options", "nosniff");
          reply.header("content-security-policy", "default-src 'none'; sandbox");
          reply.header("cache-control", "no-store");
          return reply.send(object.body);
        } catch (error) {
          if (error instanceof ServiceError) throw error;
          throw new ServiceError(503, "files-unavailable", "Files could not complete the request.");
        }
      });
    }

    app.post(
      `${byWorkspace}/buckets`,
      caller(async (request, _reply, principal) => {
        const body = parse(z.object({ name: bucketName }), request.body);
        const w = await this.#admitted(principal, (request.params as { id: string }).id, true);
        await this.#store.createBucket(w.id, body.name);
        return { data: { name: body.name }, error: null };
      }),
    );

    app.get(
      `${byWorkspace}/buckets`,
      caller(async (request, _reply, principal) => {
        const w = await this.#admitted(principal, (request.params as { id: string }).id, false);
        return { data: await this.#store.listBuckets(w.id), error: null };
      }),
    );

    app.register(async (scope) => {
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser("*", (_req, payload, done) => {
        done(null, payload);
      });

      scope.post(
        `${FILES}/:id/files/buckets/:bucket/objects`,
        caller(async (request, reply, principal) => {
          const params = request.params as { id: string; bucket: string };
          const bucket = parse(bucketName, params.bucket);
          const query = request.query as Record<string, unknown>;
          const path = parse(objectPath, query.path);
          const options = uploadOptions.safeParse(query);
          const upsert =
            options.success && (options.data.upsert === true || options.data.upsert === "true");
          const w = await this.#bucket(principal, params.id, bucket, true);
          const key = bucketObjectKey(w.id, bucket, path);
          const upload = uploadBody(request);
          const contentType =
            (options.success ? options.data.contentType : undefined) ??
            (typeof request.headers["content-type"] === "string"
              ? request.headers["content-type"].split(";")[0]?.trim()
              : undefined) ??
            "application/octet-stream";
          const cacheControl = normalizeCacheControl(
            options.success ? options.data.cacheControl : undefined,
          );
          await this.#store.putObject({
            key,
            body: upload.body,
            ...(upload.contentLength !== undefined ? { contentLength: upload.contentLength } : {}),
            contentType,
            cacheControl,
            ifNoneMatch: !upsert,
          });
          const objectId = stableId(key);
          reply.code(200);
          return { data: { path, id: objectId, fullPath: `${bucket}/${path}` }, error: null };
        }),
      );
    });

    app.get(
      `${FILES}/:id/files/buckets/:bucket/objects`,
      caller(async (request, reply, principal) => {
        const params = request.params as { id: string; bucket: string };
        const bucket = parse(bucketName, params.bucket);
        const path = parse(objectPath, (request.query as { path?: string }).path);
        const w = await this.#bucket(principal, params.id, bucket, false);
        const key = bucketObjectKey(w.id, bucket, path);
        const object = await this.#store.getObject(key);
        reply.header("content-type", object.contentType ?? "application/octet-stream");
        // Authenticated TDAS downloads stay no-store; object cacheControl is preserved on S3/signed URLs.
        reply.header("cache-control", "no-store");
        if (object.etag) reply.header("etag", object.etag);
        return reply.send(object.body);
      }),
    );

    app.post(
      `${FILES}/:id/files/buckets/:bucket/list`,
      caller(async (request, _reply, principal) => {
        const params = request.params as { id: string; bucket: string };
        const bucket = parse(bucketName, params.bucket);
        const body = parse(
          z.object({
            prefix: z.string().max(1024).optional().default(""),
            limit: z.number().int().min(1).max(1000).optional().default(100),
            offset: z.number().int().min(0).optional().default(0),
            search: z.string().max(256).optional(),
          }),
          request.body ?? {},
        );
        const w = await this.#bucket(principal, params.id, bucket, false);
        const prefix = bucketPrefix(w.id, bucket, body.prefix);
        const data = await this.#store.listObjects(prefix, body);
        return { data, error: null };
      }),
    );

    app.post(
      `${FILES}/:id/files/buckets/:bucket/remove`,
      caller(async (request, _reply, principal) => {
        const params = request.params as { id: string; bucket: string };
        const bucket = parse(bucketName, params.bucket);
        const body = parse(z.object({ paths: z.array(objectPath).min(1).max(1000) }), request.body);
        const w = await this.#bucket(principal, params.id, bucket, true);
        const keys = body.paths.map((p) => bucketObjectKey(w.id, bucket, p));
        await this.#store.deleteObjects(keys);
        return { data: body.paths.map((name) => ({ name })), error: null };
      }),
    );

    app.post(
      `${FILES}/:id/files/buckets/:bucket/sign`,
      caller(async (request, _reply, principal) => {
        const params = request.params as { id: string; bucket: string };
        const bucket = parse(bucketName, params.bucket);
        const body = parse(
          z.object({
            path: objectPath,
            expiresIn: z.number().int().min(1).max(MAX_SIGNED_URL_SECONDS),
          }),
          request.body,
        );
        const w = await this.#bucket(principal, params.id, bucket, false);
        const key = bucketObjectKey(w.id, bucket, body.path);
        const signedUrl = await this.#store.signedGetUrl(key, body.expiresIn);
        return { data: { signedUrl }, error: null };
      }),
    );
  }
}

export type FilesDeploymentOptions = { sealer: Sealer; publicOrigin: string };

export function filesDeployment(
  config: FilesConfiguration,
  authority: FilesWorkspaceAuthority | { unavailable: string },
  options: FilesDeploymentOptions,
): ServiceDeployment {
  return {
    id: "files",
    contractHref: CONTRACT,
    publicHref: FILES,
    async open(guards) {
      if ("reason" in config) {
        return {
          routes(app) {
            app.get(
              "/v1/admin/files",
              handle(guards.requireOperator, async () => ({
                state: "unavailable",
                reason: config.reason,
              })),
            );
          },
          discover: async () => ({ state: "unavailable", reason: "files-unavailable" }),
        };
      }
      if ("unavailable" in authority) {
        return {
          routes(app) {
            app.get(
              "/v1/admin/files",
              handle(guards.requireOperator, async () => ({
                state: "unavailable",
                reason: authority.unavailable,
              })),
            );
          },
          discover: async () => ({ state: "unavailable", reason: "files-unavailable" }),
        };
      }
      let downloads: LocalDownloads | undefined;
      let store: FilesBackend;
      if (config.backend === "local") {
        downloads = new LocalDownloads(options.sealer, options.publicOrigin);
        store = new LocalStore({ root: config.root, downloads });
      } else {
        store = new S3Store(config);
      }
      const files = new Files(authority, store, downloads);
      return {
        routes: (app) => files.routes(app, guards),
        discover: (principal) => files.discover(principal),
        close: async () => {
          await store.close();
        },
      };
    },
  };
}
