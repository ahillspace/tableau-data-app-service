import type pg from "pg";
import { ServiceError } from "../platform/errors.ts";
import { buildWorkspaceSchema } from "./engine.ts";
import { storagePool } from "./postgres.ts";

export type WorkspaceSchema = Awaited<ReturnType<typeof buildWorkspaceSchema>>;

type Scope = {
  pool: pg.Pool;
  uses: number;
  touched: number;
  closing?: Promise<void>;
  schema?: { revision: number; build: Promise<WorkspaceSchema> };
};

/** One connection per active database login, and a finite shared budget across all workspaces. */
export class WorkspaceScopes {
  readonly #scopes = new Map<string, Scope>();
  readonly #sweep: NodeJS.Timeout;
  readonly #ca: string | undefined;
  readonly #limit: number;

  constructor(ca: string | undefined, limit: number) {
    this.#ca = ca;
    this.#limit = limit;
    this.#sweep = setInterval(() => {
      for (const [login, scope] of this.#scopes)
        if (!scope.uses && scope.touched < Date.now() - 60_000) void this.#remove(login, scope);
    }, 30_000);
    this.#sweep.unref();
  }

  #remove(login: string, scope: Scope): Promise<void> {
    scope.closing ??= scope.pool.end().finally(() => {
      this.#scopes.delete(login);
    });
    return scope.closing;
  }

  async #reserve(login: string, url: string): Promise<Scope> {
    for (;;) {
      const existing = this.#scopes.get(login);
      if (existing) {
        if (existing.closing) {
          await existing.closing;
          continue;
        }
        existing.uses++;
        return existing;
      }
      if (this.#scopes.size < this.#limit) {
        const scope = { pool: storagePool(url, this.#ca, 1), uses: 1, touched: Date.now() };
        this.#scopes.set(login, scope);
        return scope;
      }
      const idle = [...this.#scopes].filter(([, scope]) => !scope.uses);
      idle.sort(([, a], [, b]) => a.touched - b.touched);
      const oldest = idle[0];
      if (!oldest) throw new ServiceError(503, "storage-busy", "Storage connections are in use");
      await this.#remove(...oldest);
    }
  }

  async #use<T>(login: string, url: string, work: (scope: Scope) => Promise<T>): Promise<T> {
    const scope = await this.#reserve(login, url);
    try {
      return await work(scope);
    } finally {
      scope.uses--;
      scope.touched = Date.now();
    }
  }

  withPool<T>(login: string, url: string, work: (pool: pg.Pool) => Promise<T>): Promise<T> {
    return this.#use(login, url, (scope) => work(scope.pool));
  }

  withSchema<T>(
    login: string,
    url: string,
    namespace: string,
    revision: number,
    readOnly: boolean,
    validRevision: () => Promise<boolean>,
    work: (schema: WorkspaceSchema) => Promise<T>,
  ): Promise<T> {
    return this.#use(login, url, async (scope) => {
      let cached = scope.schema;
      if (cached?.revision !== revision) {
        const build = buildWorkspaceSchema(scope.pool, namespace, readOnly);
        cached = { revision, build };
        // An earlier admission may have been delayed while a newer version was cached.
        if (!scope.schema || revision > scope.schema.revision) scope.schema = cached;
        void build.catch(() => {
          if (scope.schema?.build === build) delete scope.schema;
        });
      }
      let schema: WorkspaceSchema;
      try {
        schema = await cached.build;
      } catch {
        if (!(await validRevision())) throw modelChanged();
        throw new ServiceError(
          503,
          "storage-schema-unavailable",
          `Storage schema generation failed at revision ${revision}`,
        );
      }
      if (!(await validRevision())) {
        if (scope.schema === cached) delete scope.schema;
        throw modelChanged();
      }
      return work(schema);
    });
  }

  async close(): Promise<void> {
    clearInterval(this.#sweep);
    await Promise.all([...this.#scopes].map(([login, scope]) => this.#remove(login, scope)));
  }
}

function modelChanged(): ServiceError {
  return new ServiceError(
    409,
    "storage-model-changed",
    "The model changed during schema admission. Refresh the schema and try again.",
  );
}
