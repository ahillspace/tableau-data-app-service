import type { FilesApi } from "./files.js";
import { filesApi } from "./files.ts";
import type { Service } from "./index.js";

export type GraphQLError = {
  message: string;
  locations?: { line: number; column: number }[];
  path?: (string | number)[];
  extensions?: Record<string, unknown>;
};

export class StorageGraphQLError<Data = unknown> extends Error {
  readonly errors: GraphQLError[];
  readonly data: Data | null | undefined;

  constructor(errors: GraphQLError[], data?: Data | null) {
    super(errors[0]?.message ?? "Storage GraphQL failed");
    this.name = "StorageGraphQLError";
    this.errors = errors;
    this.data = data;
  }
}

export type StorageWorkspace = {
  graphql<Data = unknown>(
    query: string,
    variables?: Record<string, unknown> | null,
    operationName?: string | null,
  ): Promise<Data>;
  files: FilesApi;
};

/** Use the Data App's existing Service instance for this workspace's GraphQL and Files requests. */
export function workspace(service: Pick<Service, "request">, id: string): StorageWorkspace {
  if (!id || id === "." || id === "..") throw new Error("A valid Storage workspace ID is required");
  const path = `/v1/storage/workspaces/${encodeURIComponent(id)}/graphql`;
  return {
    async graphql<Data = unknown>(
      query: string,
      variables?: Record<string, unknown> | null,
      operationName?: string | null,
    ): Promise<Data> {
      const response = await service.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query, variables, operationName }),
      });
      const result = (await response.json()) as { data?: Data | null; errors?: GraphQLError[] };
      if (result?.errors?.length) throw new StorageGraphQLError(result.errors, result.data);
      if (result?.data == null) throw new Error("Storage GraphQL returned no data");
      return result.data;
    },
    files: filesApi(service, id),
  };
}
