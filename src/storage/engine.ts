import type pg from "pg";
import { makeSchema } from "postgraphile";
import { execute, isAsyncIterable } from "postgraphile/grafast";
import {
  type GraphQLError,
  getOperationAST,
  parse,
  printSchema,
  validate,
  visit,
} from "postgraphile/graphql";
import { PostGraphileAmberPreset } from "postgraphile/presets/amber";
import { ServiceError } from "../platform/errors.ts";
import { workspacePgService } from "./postgres.ts";
import { type DatabaseDiagnostic, safeDiagnostic } from "./sql.ts";

const messages = new Map([
  ["23502", "A required value was not supplied"],
  ["23503", "A referenced row is missing or the row is still referenced"],
  ["23505", "A unique key already exists"],
  ["23514", "A value violates a check constraint"],
  ["42501", "Workspace privileges or a row policy denied the operation"],
  ["25006", "The admitted workspace access is read-only"],
  ["42703", "The workspace model may have changed. Refresh the schema."],
  ["42P01", "The workspace model may have changed. Refresh the schema."],
  ["55P03", "The database could not acquire a lock in time"],
  ["57014", "The database did not complete the operation in time"],
]);

function executionError(error: GraphQLError) {
  const original = (error.originalError?.cause || error.originalError || {}) as DatabaseDiagnostic;
  const diagnostic = safeDiagnostic(original);
  const serviceCode = original instanceof ServiceError ? original.code : undefined;
  const message =
    diagnostic.sqlState &&
    (messages.get(diagnostic.sqlState) ||
      (diagnostic.sqlState.startsWith("22") ? "A supplied value is invalid" : undefined));
  return {
    message:
      (original instanceof ServiceError ? original.message : message) ||
      (error.path
        ? "The workspace operation failed"
        : "GraphQL could not execute the document or its variables"),
    ...(error.path ? { path: error.path } : {}),
    ...(error.locations ? { locations: error.locations } : {}),
    ...(diagnostic.sqlState || serviceCode
      ? { extensions: { ...diagnostic, ...(serviceCode ? { code: serviceCode } : {}) } }
      : {}),
  };
}

type Input = {
  query: string;
  variables?: Record<string, unknown> | null | undefined;
  operationName?: string | null | undefined;
};

export async function buildWorkspaceSchema(pool: pg.Pool, namespace: string, readOnly: boolean) {
  const pgService = workspacePgService(pool, namespace, readOnly);
  const { schema, resolvedPreset } = await makeSchema({
    extends: [PostGraphileAmberPreset],
    disablePlugins: ["SwallowErrorsPlugin"],
    grafast: { timeouts: { planning: 2_000, execution: 35_000 } },
    pgServices: [pgService],
  });
  return {
    sdl: () => printSchema(schema),
    async execute(actor: string, input: Input) {
      const refused = (message: string) => ({ errors: [{ message }] });
      let document: ReturnType<typeof parse>;
      try {
        document = parse(input.query);
      } catch (error) {
        return refused(error instanceof Error ? error.message : "Invalid GraphQL syntax");
      }
      const operation = getOperationAST(document, input.operationName);
      if (!operation) return refused("Supply the name of one operation in the GraphQL document");
      if (operation.operation === "subscription")
        return refused("This endpoint accepts queries and mutations");
      if (operation.operation === "mutation" && (readOnly || !schema.getMutationType()))
        return refused("Mutations are unavailable in this workspace schema");
      let incremental = false;
      visit(document, {
        Directive(node) {
          if (["defer", "stream"].includes(node.name.value)) incremental = true;
        },
      });
      if (incremental) return refused("This endpoint returns one GraphQL result");
      const errors = validate(schema, document);
      if (errors.length) return { errors: errors.map((error) => error.toJSON()) };
      const result = await execute({
        schema,
        document,
        resolvedPreset,
        variableValues: input.variables,
        operationName: input.operationName,
        contextValue: {
          storageWithPgClient: pgService.adaptorSettings,
          pgSettings: { "tdas.actor_id": actor },
        },
      });
      if (isAsyncIterable(result)) {
        await result[Symbol.asyncIterator]().return?.();
        return refused("This endpoint returns one GraphQL result");
      }
      return {
        ...(result.data !== undefined ? { data: result.data } : {}),
        ...(result.errors?.length ? { errors: result.errors.map(executionError) } : {}),
      };
    },
  };
}
