import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { ServiceDeployment, ServiceDiscovery, ServiceGuards } from "../http/services.ts";
import { trustedSiteFor } from "../identity/directory.ts";
import type { Principal } from "../identity/types.ts";
import { type Db, LOCK_TIMEOUT_MS, STATEMENT_TIMEOUT_MS } from "../persistence/database.ts";
import { invalid, ServiceError } from "../platform/errors.ts";
import { fieldErrors } from "../platform/validation.ts";
import type { Sealer } from "../sealing/sealer.ts";
import type { StorageConfiguration } from "./config.ts";
import { assertStorageReady } from "./install.ts";
import {
  oneStatement,
  onScopedConnection,
  restoreRunnerSettings,
  storagePool,
} from "./postgres.ts";
import {
  digest,
  owner,
  Registry,
  requireActive,
  type Workspace,
  workspaceNotFound,
} from "./registry.ts";
import { type WorkspaceSchema, WorkspaceScopes } from "./scopes.ts";
import {
  explorationStatement,
  inspectModel,
  migrationStatements,
  statementFailure,
} from "./sql.ts";

export const WORKSPACES = "/v1/storage/workspaces";
export const ADMIN = "/v1/admin/storage";
const CONTRACT = "/v1/tools/specification.html#documents/storage";
const uuid = z.uuid();
const id = (value: unknown) => {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw workspaceNotFound();
  return parsed.data;
};
const label = z.string().trim().min(1).max(200);
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const revision = z.int().min(0).max(2147483647);
const text = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0") && value.isWellFormed());
const level = z.enum(["read", "edit"]);
const create = z.strictObject({
  label,
  creationKey: key,
  attribution: z
    .strictObject({
      appId: z.string().max(200).optional(),
      workbook: z.string().max(500).optional(),
    })
    .optional(),
});
const edit = z
  .strictObject({ label: label.optional(), state: z.enum(["active", "archived"]).optional() })
  .refine((value) => value.label !== undefined || value.state !== undefined);
const sharing = z.strictObject({
  version: revision,
  site: level.nullable(),
  grants: z.array(z.strictObject({ identityId: uuid, access: level })),
});
const migration = z.strictObject({ id: key, predecessor: revision, sql: text });
const exploration = z.strictObject({ sql: text, values: z.array(z.json()).optional() });
const graphql = z.strictObject({
  query: text,
  variables: z.record(z.string(), z.unknown()).nullish(),
  operationName: z.string().nullish(),
});
const operation = z
  .strictObject({
    state: z.enum(["active", "suspended", "retired"]).optional(),
    ownerId: uuid.optional(),
  })
  .refine((value) => value.state !== undefined || value.ownerId !== undefined);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid(fieldErrors(result.error));
  return result.data;
}

type ActorCheck = () => Promise<Principal>;

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
      // Never send driver errors, submitted SQL, credentials or variables to HTTP error logging.
      throw new ServiceError(
        503,
        "storage-unavailable",
        "Storage could not complete the request. Check Storage readiness.",
      );
    }
  };
}

const parameter = (request: FastifyRequest, name: string): unknown =>
  (request.params as Record<string, unknown>)[name];

class Storage {
  readonly #core: Db;
  readonly #registry: Registry;
  readonly #scopes: WorkspaceScopes;
  readonly #admin: pg.Pool;
  constructor(core: Db, registry: Registry, scopes: WorkspaceScopes, admin: pg.Pool) {
    this.#core = core;
    this.#registry = registry;
    this.#scopes = scopes;
    this.#admin = admin;
  }

  async readiness(): Promise<string | undefined> {
    try {
      await assertStorageReady(this.#admin);
      return undefined;
    } catch {
      return "Check the Storage connection, verified TLS, database privileges and storage-init";
    }
  }

  async discover(principal: Principal): Promise<ServiceDiscovery> {
    try {
      if (await this.readiness()) throw new Error("Storage is unavailable");
      const canCreate = await this.#registry.canCreate(principal.trustedSiteId);
      return {
        state: "available",
        canCreate,
        actions: [
          { method: "GET", href: WORKSPACES },
          ...(canCreate ? [{ method: "POST", href: WORKSPACES }] : []),
          ...(principal.kind === "operator" ? [{ method: "GET", href: ADMIN }] : []),
        ],
      };
    } catch {
      return {
        state: "unavailable",
        reason: "storage-unavailable",
        ...(principal.kind === "operator" ? { actions: [{ method: "GET", href: ADMIN }] } : {}),
      };
    }
  }

  async #view(w: Workspace, includeOwner: boolean) {
    const href = `${WORKSPACES}/${w.id}`;
    const ownerActions = includeOwner && w.access === "owner";
    return {
      id: w.id,
      label: w.label,
      attribution: w.attribution,
      access: w.access,
      state: w.state,
      revision: w.revision,
      links: {
        self: href,
        ...(w.state === "active" ? { graphql: `${href}/graphql`, schema: `${href}/schema` } : {}),
        ...(ownerActions && w.state === "active"
          ? {
              query: `${href}/query`,
              migrations: `${href}/migrations`,
              access: `${href}/access`,
              identities: `${href}/identities`,
            }
          : {}),
      },
      ...(ownerActions ? await this.#registry.ownerDetails(w) : {}),
    };
  }

  async #assertIdentity(w: Workspace, identityIds: string[]) {
    if (identityIds.length === 0) return;
    const matches = await this.#core
      .selectFrom("identities")
      .select("id")
      .where("id", "in", identityIds)
      .where("deployment_id", "=", w.home_deployment)
      .where("site_id", "=", w.home_site)
      .execute();
    if (matches.length !== new Set(identityIds).size)
      throw invalid([{ path: "identityId", rule: "verified-home-site-identity" }]);
  }

  async #model<T>(
    w: Workspace,
    readOnly: boolean,
    actor: string,
    run: (client: pg.PoolClient) => Promise<T>,
  ) {
    return this.#scopes.withPool(w.model, this.#registry.roleUrl(w, "model"), (pool) =>
      onScopedConnection(pool, w.namespace, readOnly, actor, run),
    );
  }

  async #migrate(
    w: Workspace,
    actor: Principal,
    input: z.infer<typeof migration>,
    verify: ActorCheck,
  ) {
    owner(w);
    const statements = await migrationStatements(input.sql);
    const params = [
      w.id,
      actor.identityId,
      this.#registry.secret(w, "proof"),
      input.id,
      input.predecessor,
      digest(input.sql),
    ];
    return this.#model(w, false, actor.identityId, async (client) => {
      const check = async (functionName: "migration_check" | "migration_record") => {
        try {
          const result = await client.query<{ revision: number | null }>(
            `select storage_control.${functionName}($1,$2,$3,$4,$5,$6) as revision`,
            params,
          );
          return result.rows[0]?.revision ?? null;
        } catch (error) {
          throw statementFailure(error);
        }
      };
      const previous = await check("migration_check");
      if ((await verify()).identityId !== actor.identityId)
        throw new ServiceError(403, "storage-owner-required", "Workspace owner access is required");
      if (previous !== null) return { revision: previous, replayed: true };
      for (const [i, statement] of statements.entries()) {
        try {
          // Reassert the runner's settings: an authored statement may change session state.
          await restoreRunnerSettings(client, STATEMENT_TIMEOUT_MS, LOCK_TIMEOUT_MS);
          // Extended protocol permits a single statement even if parser/server grammars differ.
          await oneStatement(client, statement);
        } catch (error) {
          throw statementFailure(error, i + 1);
        }
      }
      return { revision: await check("migration_record"), replayed: false };
    });
  }

  async #inspectModel(w: Workspace, principal: Principal) {
    owner(w);
    const model = await this.#model(w, true, principal.identityId, (client) =>
      inspectModel(client, w.namespace),
    );
    if ((await this.#registry.revision(w.id)) !== w.revision)
      throw new ServiceError(
        409,
        "storage-model-changed",
        "The model changed during schema inspection",
      );
    return model;
  }

  async #withData<T>(
    principal: Principal,
    workspaceId: string,
    run: (w: Workspace, built: WorkspaceSchema) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const w = await this.#registry.find(principal, workspaceId);
      requireActive(w);
      const role = w.access === "read" ? "reader" : "editor";
      try {
        return await this.#scopes.withSchema(
          w[role],
          this.#registry.roleUrl(w, role),
          w.namespace,
          w.revision,
          role === "reader",
          async () => (await this.#registry.revision(w.id)) === w.revision,
          (built) => run(w, built),
        );
      } catch (error) {
        // This code originates before execution. A GraphQL mutation is never replayed.
        if (attempt < 2 && error instanceof ServiceError && error.code === "storage-model-changed")
          continue;
        throw error;
      }
    }
  }

  routes(app: FastifyInstance, guards: ServiceGuards) {
    const caller = (run: Parameters<typeof handle>[1]) => handle(guards.requireCaller, run);
    const operator = (run: Parameters<typeof handle>[1]) => handle(guards.requireOperator, run);
    const byId = `${WORKSPACES}/:id`;
    const requestedId = (request: FastifyRequest) => id(parameter(request, "id"));
    const admitted = (request: FastifyRequest, principal: Principal) =>
      this.#registry.find(principal, requestedId(request));
    app.get(
      WORKSPACES,
      caller(async (_request, _reply, principal) => ({
        workspaces: await Promise.all(
          (await this.#registry.list(principal)).map((w) => this.#view(w, false)),
        ),
      })),
    );
    app.post(
      WORKSPACES,
      caller(async (request, _reply, principal) => ({
        workspace: await this.#view(
          await this.#registry.create(principal, parse(create, request.body)),
          true,
        ),
      })),
    );
    app.get(
      byId,
      caller(async (request, _reply, principal) => ({
        workspace: await this.#view(await admitted(request, principal), true),
      })),
    );
    app.patch(
      byId,
      caller(async (request, _reply, principal) => ({
        workspace: await this.#view(
          await this.#registry.edit(principal, requestedId(request), parse(edit, request.body)),
          true,
        ),
      })),
    );
    app.post(
      `${byId}/migrations`,
      caller(async (request, _reply, principal) =>
        this.#migrate(
          await admitted(request, principal),
          principal,
          parse(migration, request.body),
          () => guards.requireCaller(request),
        ),
      ),
    );
    app.post(
      `${byId}/query`,
      caller(async (request, _reply, principal) => {
        const w = await admitted(request, principal);
        owner(w);
        const input = parse(exploration, request.body);
        await explorationStatement(input.sql);
        return this.#model(w, true, principal.identityId, async (client) => {
          try {
            const result = await oneStatement(client, input.sql, input.values);
            return {
              columns: result.fields.map(({ name, dataTypeID }) => ({
                name,
                dataTypeId: dataTypeID,
              })),
              rows: result.rows,
              visibility: "model-owner",
            };
          } catch (error) {
            throw statementFailure(error);
          }
        });
      }),
    );
    app.put(
      `${byId}/access`,
      caller(async (request, _reply, principal) => {
        const input = parse(sharing, request.body);
        const ids = input.grants.map((g) => g.identityId);
        if (new Set(ids).size !== ids.length)
          throw invalid([{ path: "grants", rule: "unique-identity" }]);
        const w = await this.#registry.setAccess(
          principal,
          requestedId(request),
          input,
          (current) => this.#assertIdentity(current, ids),
        );
        return { workspace: await this.#view(w, true) };
      }),
    );
    app.get(
      `${byId}/identities`,
      caller(async (request, _reply, principal) => {
        const w = await admitted(request, principal);
        owner(w);
        const { username } = parse(
          z.strictObject({ username: z.string().trim().min(1).max(200) }),
          request.query,
        );
        const identities = await this.#core
          .selectFrom("identities")
          .select(["id as identityId", "user_name as username"])
          .where("deployment_id", "=", w.home_deployment)
          .where("site_id", "=", w.home_site)
          .where("user_name", "=", username)
          .execute();
        return { identities };
      }),
    );
    app.post(
      `${byId}/graphql`,
      caller(async (request, reply, principal) => {
        const input = parse(graphql, request.body);
        return this.#withData(principal, requestedId(request), async (w, schema) => {
          reply.header("x-tdas-storage-revision", w.revision);
          return schema.execute(principal.identityId, input);
        });
      }),
    );
    app.get(
      `${byId}/schema`,
      caller(async (request, reply, principal) => {
        const { view } = parse(
          z.strictObject({ view: z.literal("model").optional() }),
          request.query,
        );
        if (view === "model") {
          const w = await admitted(request, principal);
          const model = await this.#inspectModel(w, principal);
          reply.header("x-tdas-storage-revision", w.revision);
          return { revision: w.revision, model };
        }
        const { w, sdl } = await this.#withData(
          principal,
          requestedId(request),
          async (w, schema) => ({ w, sdl: schema.sdl() }),
        );
        const model = w.access === "owner" ? await this.#inspectModel(w, principal) : undefined;
        reply.header("x-tdas-storage-revision", w.revision);
        return { revision: w.revision, sdl, ...(model ? { model } : {}) };
      }),
    );
    app.get(
      ADMIN,
      operator(async () => {
        const reason = await this.readiness();
        if (reason) return { state: "unavailable", reason };
        const [creatorSites, workspaces] = await Promise.all([
          this.#registry.creatorSites(),
          this.#registry.operatorWorkspaces(),
        ]);
        return { state: "available", creatorSites, workspaces };
      }),
    );
    app.put(
      `${ADMIN}/sites/:siteId`,
      operator(async (request, _reply, principal) => {
        const siteId = id(parameter(request, "siteId"));
        const { enabled } = parse(z.strictObject({ enabled: z.boolean() }), request.body);
        if (enabled) {
          const site = await this.#core
            .selectFrom("trusted_sites")
            .select("id")
            .where("id", "=", siteId)
            .where("enabled", "=", true)
            .executeTakeFirst();
          if (!site) throw invalid([{ path: "siteId", rule: "enabled-trusted-site" }]);
        }
        return this.#registry.setCreatorSite(principal, siteId, enabled);
      }),
    );
    app.patch(
      `${ADMIN}/workspaces/:id`,
      operator(async (request, _reply, principal) => {
        const input = parse(operation, request.body);
        const workspace = await this.#registry.operate(
          principal,
          requestedId(request),
          input,
          async (w, subject) => {
            const operator = await guards.requireOperator(request);
            if (operator.identityId !== principal.identityId)
              throw new ServiceError(403, "operator-required", "Operator access is required");
            if (!subject) return;
            await this.#assertIdentity(w, [subject]);
            const site = await trustedSiteFor(this.#core, {
              deploymentId: w.home_deployment,
              siteId: w.home_site,
              userId: "",
            });
            if (!site) throw invalid([{ path: "ownerId", rule: "enabled-trusted-site" }]);
          },
        );
        return { workspace };
      }),
    );
    app.delete(
      `${ADMIN}/workspaces/:id`,
      operator(async (request, _reply, principal) => {
        const id = requestedId(request);
        const { confirm } = parse(z.strictObject({ confirm: uuid }), request.body);
        if (confirm !== id) throw invalid([{ path: "confirm", rule: "matches-workspace-id" }]);
        return {
          workspace: await this.#registry.purge(principal, id, () =>
            guards.requireOperator(request),
          ),
        };
      }),
    );
  }
}

export type StorageRuntime = {
  pool: pg.Pool;
  scopes: WorkspaceScopes;
  registry: Registry;
};

export function createStorageRuntime(
  config: Exclude<StorageConfiguration, { reason: string }>,
  sealer: Sealer,
): StorageRuntime {
  const pool = storagePool(config.url.href, config.ca, 2);
  const scopes = new WorkspaceScopes(config.ca, config.connections);
  const registry = new Registry(pool, config.url, sealer);
  return { pool, scopes, registry };
}

export function storageDeploymentFromRuntime(
  config: Exclude<StorageConfiguration, { reason: string }>,
  core: Db,
  runtime: StorageRuntime,
): ServiceDeployment {
  return {
    id: "storage",
    contractHref: CONTRACT,
    publicHref: WORKSPACES,
    open(guards) {
      const storage = new Storage(core, runtime.registry, runtime.scopes, runtime.pool);
      return {
        routes: (app) => storage.routes(app, guards),
        discover: (principal) => storage.discover(principal),
        close: async () => {
          await Promise.all([runtime.scopes.close(), runtime.pool.end()]);
        },
      };
    },
  };
}

export function storageDeployment(
  config: StorageConfiguration,
  core: Db,
  sealer: Sealer,
): ServiceDeployment {
  if ("reason" in config) {
    return {
      id: "storage",
      contractHref: CONTRACT,
      publicHref: WORKSPACES,
      open(guards) {
        return {
          routes(app) {
            app.get(
              ADMIN,
              handle(guards.requireOperator, async () => ({
                state: "unavailable",
                reason: config.reason,
              })),
            );
            app.get(
              WORKSPACES,
              handle(guards.requireCaller, async () => {
                throw new ServiceError(503, "storage-unavailable", "Storage is unavailable");
              }),
            );
          },
          discover: (principal) => ({
            state: "unavailable",
            reason: "storage-unavailable",
            ...(principal.kind === "operator" ? { actions: [{ method: "GET", href: ADMIN }] } : {}),
          }),
        };
      },
    };
  }
  const runtime = createStorageRuntime(config, sealer);
  return storageDeploymentFromRuntime(config, core, runtime);
}
