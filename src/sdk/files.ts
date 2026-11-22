import type { Service, ServiceError } from "./index.js";

export type FilesObject = { path: string; id: string; fullPath: string };
export type FilesListObject = {
  name: string;
  id: string | null;
  updated_at: string | null;
  created_at: string | null;
  last_accessed_at: string | null;
  metadata: Record<string, unknown> | null;
};

export type UploadOptions = {
  upsert?: boolean;
  contentType?: string;
  cacheControl?: string;
};

type FilesResult<T> = Promise<{ data: T | null; error: ServiceError | null }>;

async function asResult<T>(run: () => Promise<T>): FilesResult<T> {
  try {
    return { data: await run(), error: null };
  } catch (error) {
    return { data: null, error: error as ServiceError };
  }
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export function filesApi(service: Pick<Service, "request">, workspaceId: string) {
  const base = `/v1/storage/workspaces/${encodeURIComponent(workspaceId)}/files/buckets`;
  function bucket(bucketId: string) {
    if (!bucketId) throw new Error("A Files bucket ID is required");
    const bucketBase = `${base}/${encodeURIComponent(bucketId)}`;
    return {
      async upload(
        path: string,
        body: BodyInit,
        options: UploadOptions = {},
      ): FilesResult<FilesObject> {
        return asResult(async () => {
          const url = `${bucketBase}/objects?path=${encodeURIComponent(path)}&upsert=${options.upsert ? "true" : "false"}${options.contentType ? `&contentType=${encodeURIComponent(options.contentType)}` : ""}${options.cacheControl ? `&cacheControl=${encodeURIComponent(options.cacheControl)}` : ""}`;
          const response = await service.request(url, {
            method: "POST",
            headers: options.contentType ? { "content-type": options.contentType } : {},
            body,
          });
          const result = await readJson<{ data: FilesObject }>(response);
          return result.data;
        });
      },
      async download(path: string): FilesResult<Blob> {
        return asResult(async () => {
          const response = await service.request(
            `${bucketBase}/objects?path=${encodeURIComponent(path)}`,
            { method: "GET" },
          );
          return await response.blob();
        });
      },
      async list(
        prefix = "",
        options: { limit?: number; offset?: number; search?: string } = {},
      ): FilesResult<FilesListObject[]> {
        return asResult(async () => {
          const response = await service.request(`${bucketBase}/list`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prefix, ...options }),
          });
          const result = await readJson<{ data: FilesListObject[] }>(response);
          return result.data;
        });
      },
      async remove(paths: string[]): FilesResult<{ name: string }[]> {
        return asResult(async () => {
          const response = await service.request(`${bucketBase}/remove`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ paths }),
          });
          const result = await readJson<{ data: { name: string }[] }>(response);
          return result.data;
        });
      },
      async createSignedUrl(path: string, expiresIn: number): FilesResult<{ signedUrl: string }> {
        return asResult(async () => {
          const response = await service.request(`${bucketBase}/sign`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path, expiresIn }),
          });
          const result = await readJson<{ data: { signedUrl: string } }>(response);
          return result.data;
        });
      },
    };
  }

  return {
    async createBucket(name: string): FilesResult<{ name: string }> {
      return asResult(async () => {
        const response = await service.request(base, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const result = await readJson<{ data: { name: string } }>(response);
        return result.data;
      });
    },
    async listBuckets(): FilesResult<{ name: string }[]> {
      return asResult(async () => {
        const response = await service.request(base, { method: "GET" });
        const result = await readJson<{ data: { name: string }[] }>(response);
        return result.data;
      });
    },
    from(bucketId: string) {
      return bucket(bucketId);
    },
  };
}

export type FilesApi = ReturnType<typeof filesApi>;
