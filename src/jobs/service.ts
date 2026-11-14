import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import type {
  AccessContext,
  BackgroundAuthorityPort,
  ClaimRef,
  OperationAuthority,
} from "../core-ports.js";
import type { CoreTransaction } from "../db/database.js";
import { absent, ServiceError } from "../http/errors.js";
import { capabilityRefSchema, type JobView, opaqueId } from "../public/schemas.js";
import type { JobRow, JobsDB, JobsTransaction, PayloadRow } from "./database.js";
import type { PreparedPayload, SubmissionHead } from "./payloads.js";
import type {
  ExecutionOutcome,
  ExternalTask,
  JobDeclaration,
  JobError,
  JobHintPort,
  JobLimits,
  JobsOptions,
  ObservationOutcome,
  OriginalAuthority,
} from "./types.js";

export type { JobHintPort } from "./types.js";

const headSchema = z.strictObject({
  handle: z.number().int().positive(),
  submissionId: opaqueId,
  capability: capabilityRefSchema,
  connectionId: opaqueId.optional(),
});
const safeError = z.strictObject({
  code: z.string().min(1).max(100),
  message: z.string().max(1000),
});
const terminal = (row: JobRow) => row.completed_at !== null;
const defaults: JobLimits = {
  inputBytes: 100000000,
  resultBytes: 100000000,
  executionSeconds: 86400,
  resultRetentionMs: 7 * 86400000,
  metadataRetentionMs: 30 * 86400000,
};
export const coreTx = (tx: JobsTransaction) => tx as unknown as CoreTransaction;
export async function wallTime(tx: JobsDB | JobsTransaction): Promise<Date> {
  return (await sql<{ time: Date }>`select clock_timestamp() as time`.execute(tx)).rows[0]!.time;
}
export class JobsService implements BackgroundAuthorityPort, JobHintPort {
  readonly db: JobsDB;
  readonly control: JobsDB;
  readonly limits: JobLimits;
  readonly #declarations = new Map<string, JobDeclaration>();
  readonly #schemas = new WeakMap<z.ZodType, object>();
  constructor(readonly options: JobsOptions) {
    this.db =
      options.core.db.withTables<
        Pick<import("./database.js").JobsDatabase, "jobs" | "job_payloads">
      >();
    this.control =
      options.core.controlDb.withTables<
        Pick<import("./database.js").JobsDatabase, "jobs" | "job_payloads">
      >();
    this.limits = { ...defaults, ...options.limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        (["inputBytes", "resultBytes", "executionSeconds"].includes(key) &&
          value > defaults[key as keyof JobLimits])
      )
        throw new Error("Invalid Job limits");
    }
    if (this.limits.resultRetentionMs > this.limits.metadataRetentionMs)
      throw new Error("Results cannot outlive metadata");
    const origin = new URL(options.callbackOrigin);
    if (origin.pathname !== "/" || origin.search || origin.hash)
      throw new Error("Invalid callback origin");
    for (const declaration of options.declarations) {
      const key = this.key(declaration.ref);
      if (this.#declarations.has(key)) throw new Error("Duplicate Job declaration");
      for (const [field, limit] of [
        ["inputLimitBytes", defaults.inputBytes],
        ["resultLimitBytes", defaults.resultBytes],
        ["executionLimitSeconds", defaults.executionSeconds],
      ] as const) {
        const value = declaration[field];
        if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > limit))
          throw new Error("Invalid operation limit");
      }
      if (
        declaration.retry &&
        (declaration.retry.delaysMs.length > 100 ||
          declaration.retry.delaysMs.some((v) => !Number.isSafeInteger(v) || v < 0))
      )
        throw new Error("Invalid finite retry policy");
      if (
        declaration.external &&
        (!Number.isSafeInteger(declaration.external.contextLimitBytes) ||
          declaration.external.contextLimitBytes <= 0 ||
          declaration.external.contextLimitBytes > defaults.inputBytes)
      )
        throw new Error("Invalid task context bound");
      // Reject transforms/opaque validation that cannot preserve retained comparison semantics.
      this.schema(declaration.inputSchema);
      this.schema(declaration.resultSchema);
      if (declaration.external) this.schema(declaration.external.contextSchema);
      this.#declarations.set(key, declaration);
    }
  }
  key(ref: { id: string; version: number }): string {
    return `${ref.id}:${ref.version}`;
  }
  declaration(
    row: Pick<JobRow, "capability_id" | "capability_version">,
  ): JobDeclaration | undefined {
    return this.#declarations.get(
      this.key({ id: row.capability_id, version: row.capability_version }),
    );
  }
  schema(schema: z.ZodType): object {
    const cached = this.#schemas.get(schema);
    if (cached) return cached;
    const converted = z.toJSONSchema(schema, {
      io: "input",
      override: ({ zodSchema }) => {
        // The exporter cannot encode these Zod semantics. Reject them rather than
        // silently dropping author validation or comparing a different command.
        const def = zodSchema._zod.def as {
          type: string;
          coerce?: boolean;
          catchall?: unknown;
          checks?: readonly { _zod: { def: { check: string } } }[];
        };
        if (
          def.coerce ||
          ["catch", "prefault"].includes(def.type) ||
          (def.type === "object" && def.catchall === undefined) ||
          def.checks?.some((check) => ["custom", "overwrite"].includes(check._zod.def.check))
        )
          throw new Error(
            "Job schemas require JSON Schema validation/defaults with explicit strict or loose objects",
          );
      },
    });
    const inspect = (node: unknown, choice = false): void => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return;
      const value = node as Record<string, unknown>;
      if (choice && Object.hasOwn(value, "default"))
        throw new Error("Job defaults inside schema alternatives are unsupported");
      for (const key of ["properties", "$defs", "patternProperties"])
        if (value[key] && typeof value[key] === "object")
          for (const child of Object.values(value[key] as object)) inspect(child, choice);
      for (const key of ["items", "additionalProperties", "contains", "propertyNames"])
        inspect(value[key], choice);
      for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"])
        if (Array.isArray(value[key]))
          for (const child of value[key])
            inspect(child, choice || key === "anyOf" || key === "oneOf");
    };
    inspect(converted);
    this.#schemas.set(schema, converted);
    return converted;
  }

  hint(id: string): void {
    if (!this.options.onHint) return;
    // A lossy hint may coalesce committed transitions. Always publish a persisted
    // revision, never an event sequence, timestamp surrogate, or invented value.
    void this.control
      .selectFrom("jobs")
      .select("revision")
      .where("id", "=", id)
      .executeTakeFirst()
      .then((row) => {
        if (row) this.options.onHint?.(id, row.revision);
      })
      .catch(() => {});
  }

  binding(row: Pick<JobRow, "id" | "provider_registration_id">, kind: string, revision = "1") {
    return { kind: `job-${kind}`, id: row.id, provider: row.provider_registration_id, revision };
  }
  scope(row: JobRow, purpose: OriginalAuthority["purpose"]): OriginalAuthority {
    return {
      access: {
        ownerId: row.owner_id,
        deploymentId: row.deployment_id,
        siteId: row.site_id,
        subjectId: row.subject_id,
        appId: row.app_id,
      },
      providerRegistrationId: row.provider_registration_id,
      ...(row.connection_id
        ? { connectionId: row.connection_id, authorityGeneration: row.authority_generation! }
        : {}),
      started: row.started_at !== null,
      purpose,
    };
  }
  async row(id: string, db = this.db): Promise<JobRow | undefined> {
    return db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirst();
  }
  async visible(
    tx: JobsTransaction,
    access: AccessContext,
    hint: JobRow,
    update = false,
  ): Promise<JobRow> {
    await this.options.core.access.lockAuthority(coreTx(tx), access);
    if (
      hint.owner_id !== access.ownerId ||
      hint.deployment_id !== access.deploymentId ||
      hint.site_id !== access.siteId
    )
      absent();
    if (hint.connection_id) {
      await tx
        .selectFrom("connections")
        .select("id")
        .where("id", "=", hint.connection_id)
        .forShare()
        .executeTakeFirst();
      if (!(await this.options.core.access.connectionVisible(access, hint.connection_id))) absent();
    }
    let query = tx.selectFrom("jobs").selectAll().where("id", "=", hint.id);
    query = update ? query.forUpdate() : query.forShare();
    const row = await query.executeTakeFirst();
    const now = await wallTime(tx);
    if (
      !row ||
      row.owner_id !== access.ownerId ||
      (row.record_expires_at && row.record_expires_at <= now)
    )
      absent();
    if (access.authenticationExpiresAt <= now)
      throw new ServiceError(401, "authentication-required", "Verified authentication required");
    return row;
  }
  async get(access: AccessContext, id: string): Promise<JobView> {
    const hint = await this.row(id);
    if (!hint) absent();
    return this.control
      .transaction()
      .execute(async (tx) => this.view(await this.visible(tx, access, hint), await wallTime(tx)));
  }
  async disclose(access: AccessContext, id: string): Promise<{ id: string } | null> {
    try {
      await this.get(access, id);
      return { id };
    } catch (error) {
      if (error instanceof ServiceError && [401, 403, 404].includes(error.status)) return null;
      throw error;
    }
  }
  view(row: JobRow, now: Date): JobView {
    return {
      id: row.id,
      appId: row.app_id,
      capability: { id: row.capability_id, version: row.capability_version },
      state: row.state,
      submittedAt: row.submitted_at.toISOString(),
      ...(row.started_at
        ? {
            startedAt: row.started_at.toISOString(),
            executionDeadline: row.deadline!.toISOString(),
          }
        : {}),
      ...(row.completed_at
        ? {
            completedAt: row.completed_at.toISOString(),
            recordExpiresAt: row.record_expires_at!.toISOString(),
          }
        : {}),
      ...(row.blocked_reason ? { blockedReason: row.blocked_reason } : {}),
      ...(row.progress
        ? {
            progress: (row.progress as { value: unknown }).value as NonNullable<
              JobView["progress"]
            >,
          }
        : {}),
      result: {
        availability: !terminal(row)
          ? "not-ready"
          : row.result_expires_at && row.result_expires_at <= now
            ? "expired"
            : row.has_result
              ? "available"
              : "none",
        ...(row.result_expires_at ? { expiresAt: row.result_expires_at.toISOString() } : {}),
      },
      ...(row.error ? { error: row.error } : {}),
      cancellation: { requested: row.requested, remote: row.remote_status },
    };
  }
  async admit(access: AccessContext, raw: Uint8Array): Promise<{ created: boolean; job: JobView }> {
    const rawBytes = raw.byteLength;
    const release = this.options.payloads.reserve(rawBytes * 8);
    let releaseNew: (() => void) | undefined;
    let head: SubmissionHead | undefined;
    let handle: number | undefined;
    try {
      const inspected = await this.options.payloads.inspect(raw);
      handle = inspected.handle;
      head = headSchema.parse(inspected);
      const existing = await this.findSubmission(access, head.submissionId);
      if (existing) return await this.recover(access, head, existing);
      const declaration = this.#declarations.get(this.key(head.capability));
      if (!declaration || declaration.acceptsSubmissions === false)
        throw new ServiceError(422, "unsupported-capability", "Job entrypoint is unavailable");
      const use = await this.options.core.connections.authorizeUse(
        access,
        declaration.providerRegistrationId,
        head.connectionId,
      );
      releaseNew = this.options.payloads.reserve(rawBytes * 8);
      const id = randomUUID();
      const schema = this.schema(declaration.inputSchema);
      const prepared = await this.options.payloads.prepare(
        head.handle,
        schema,
        this.binding({ id, provider_registration_id: declaration.providerRegistrationId }, "input"),
        Math.min(declaration.inputLimitBytes ?? this.limits.inputBytes, this.limits.inputBytes),
      );
      if (!prepared.payload) throw new Error("Missing prepared Job input");
      const result = await this.db
        .transaction()
        .execute(async (tx) => {
          // Stage large bytes before authority locks. Deferred FK is checked at commit.
          await this.insertPayload(tx, id, "input", prepared.payload!);
          await this.options.core.access.lockAuthority(
            coreTx(tx),
            access,
            declaration.providerRegistrationId,
          );
          await this.options.core.connections.lockBackground(coreTx(tx), {
            access,
            providerRegistrationId: declaration.providerRegistrationId,
            ...(use
              ? { connectionId: use.connectionId, authorityGeneration: use.authorityGeneration }
              : {}),
            started: false,
            purpose: "start",
          });
          const registration = await tx
            .selectFrom("provider_registrations")
            .selectAll()
            .where("id", "=", declaration.providerRegistrationId)
            .executeTakeFirstOrThrow();
          const connection = use
            ? await tx
                .selectFrom("connections")
                .select("account_key")
                .where("id", "=", use.connectionId)
                .executeTakeFirstOrThrow()
            : null;
          const now = await wallTime(tx);
          if (access.authenticationExpiresAt <= now)
            throw new ServiceError(
              401,
              "authentication-required",
              "Verified authentication required",
            );
          const row = await tx
            .insertInto("jobs")
            .values({
              id,
              app_id: access.appId,
              owner_id: access.ownerId,
              deployment_id: access.deploymentId,
              site_id: access.siteId,
              subject_id: access.subjectId,
              submission_id: head!.submissionId,
              capability_id: declaration.ref.id,
              capability_version: declaration.ref.version,
              provider_registration_id: declaration.providerRegistrationId,
              provider_revision: registration.config_revision,
              connection_id: use?.connectionId ?? null,
              authority_generation: use?.authorityGeneration ?? null,
              account_key: connection
                ? connection.account_key
                : `none:${declaration.providerRegistrationId}`,
              comparison_version: 1,
              comparison_digest: prepared.digest,
              comparison_schema: schema,
              input_limit: Math.min(
                declaration.inputLimitBytes ?? this.limits.inputBytes,
                this.limits.inputBytes,
              ),
              result_limit: Math.min(
                declaration.resultLimitBytes ?? this.limits.resultBytes,
                this.limits.resultBytes,
              ),
              execution_seconds: Math.min(
                declaration.executionLimitSeconds ?? this.limits.executionSeconds,
                this.limits.executionSeconds,
              ),
              result_retention_ms: this.limits.resultRetentionMs,
              metadata_retention_ms: this.limits.metadataRetentionMs,
              state: "queued",
              revision: 1,
              submitted_at: now,
              due_at: now,
              started_at: null,
              deadline: null,
              completed_at: null,
              result_expires_at: null,
              record_expires_at: null,
              has_result: false,
              claim_token: null,
              incarnation: null,
              claim_kind: null,
              lease_until: null,
              attempts: 0,
              invocation_token: null,
              invocation_incarnation: null,
              requested: false,
              remote_status: "not-requested",
              blocked_reason: null,
              progress: null,
              error: null,
              task_id: null,
              callback_correlation: null,
              cleanup_deadline: null,
              cleanup_token: null,
              cleanup_incarnation: null,
              cleanup_lease: null,
              cancel_issued_at: null,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          return this.view(row, now);
        })
        .catch(async (error) => {
          if ((error as { code?: string }).code !== "23505") throw error;
          const existing = await this.findSubmission(access, head!.submissionId);
          if (!existing) throw error;
          return (await this.recover(access, head!, existing)).job;
        });
      this.hint(result.id);
      return { created: result.id === id, job: result };
    } finally {
      try {
        if (handle) await this.options.payloads.release(handle);
      } finally {
        releaseNew?.();
        release();
      }
    }
  }
  async findSubmission(access: AccessContext, id: string): Promise<JobRow | undefined> {
    return this.db
      .selectFrom("jobs")
      .selectAll()
      .where("app_id", "=", access.appId)
      .where("owner_id", "=", access.ownerId)
      .where("submission_id", "=", id)
      .executeTakeFirst();
  }
  async recover(
    access: AccessContext,
    head: SubmissionHead,
    hint: JobRow,
  ): Promise<{ created: false; job: JobView }> {
    await this.control.transaction().execute((tx) => this.visible(tx, access, hint));
    if (hint.comparison_version !== 1)
      throw new ServiceError(
        409,
        "submission-conflict",
        "Submission comparison version is unavailable",
      );
    const prepared = await this.options.payloads.prepare(head.handle, hint.comparison_schema);
    return this.control.transaction().execute(async (tx) => {
      const row = await this.visible(tx, access, hint);
      if (row.comparison_digest !== prepared.digest)
        throw new ServiceError(
          409,
          "submission-conflict",
          "Submission key already names a different command",
        );
      return { created: false, job: this.view(row, await wallTime(tx)) };
    });
  }
  async insertPayload(
    tx: JobsTransaction,
    id: string,
    kind: PayloadRow["kind"],
    payload: PreparedPayload,
  ): Promise<void> {
    await tx
      .insertInto("job_payloads")
      .values({ ...payload, job_id: id, kind })
      .execute();
  }
  async payload(row: JobRow, kind: PayloadRow["kind"], raw = false): Promise<unknown> {
    const payload = await this.db
      .selectFrom("job_payloads")
      .selectAll()
      .where("job_id", "=", row.id)
      .where("kind", "=", kind)
      .executeTakeFirstOrThrow();
    return this.options.payloads.open(payload, this.binding(row, kind, payload.revision), raw);
  }
  async result(
    access: AccessContext,
    id: string,
    raw = false,
    retain?: (release: () => void) => void,
  ): Promise<unknown> {
    const hint = await this.row(id);
    if (!hint) absent();
    const row = await this.control.transaction().execute(async (tx) => {
      const row = await this.visible(tx, access, hint);
      this.resultAvailable(row, await wallTime(tx));
      return row;
    });
    const metadata = await this.db
      .selectFrom("job_payloads")
      .select("bytes")
      .where("job_id", "=", row.id)
      .where("kind", "=", "result")
      .executeTakeFirst();
    if (!metadata) {
      await this.control
        .transaction()
        .execute(async (tx) =>
          this.resultAvailable(await this.visible(tx, access, row), await wallTime(tx)),
        );
      throw new Error("Retained result body missing");
    }
    const release = this.options.payloads.reserve(metadata.bytes * 8);
    let retained = false;
    try {
      let value: unknown;
      try {
        value = await this.payload(row, "result", raw);
      } catch (error) {
        await this.control
          .transaction()
          .execute(async (tx) =>
            this.resultAvailable(await this.visible(tx, access, row), await wallTime(tx)),
          );
        throw error;
      }
      await this.control.transaction().execute(async (tx) => {
        const fresh = await this.visible(tx, access, row);
        this.resultAvailable(fresh, await wallTime(tx));
        if (fresh.completed_at?.getTime() !== row.completed_at?.getTime())
          throw new Error("Result reference changed");
      });
      if (retain) {
        retain(release);
        retained = true;
      }
      return value;
    } finally {
      if (!retained) release();
    }
  }
  async resultLease(access: AccessContext, id: string): Promise<{ body: Buffer; dispose(): void }> {
    let dispose = () => {};
    const value = (await this.result(access, id, true, (release) => {
      dispose = release;
    })) as Uint8Array;
    return { body: Buffer.from(value.buffer, value.byteOffset, value.byteLength), dispose };
  }
  resultAvailable(row: JobRow, now: Date): void {
    if (!terminal(row)) throw new ServiceError(409, "result-not-ready", "Job result is not ready");
    if (row.result_expires_at && row.result_expires_at <= now)
      throw new ServiceError(410, "result-expired", "Job result expired");
    if (!row.has_result) throw new ServiceError(404, "no-result", "Job has no result");
  }
  async cancel(access: AccessContext, id: string, cleanupMs: number): Promise<JobView> {
    const hint = await this.row(id);
    if (!hint) absent();
    const result = await this.control.transaction().execute(async (tx) => {
      let row = await this.visible(tx, access, hint, true);
      if (terminal(row)) {
        if (!row.requested)
          row = await tx
            .updateTable("jobs")
            .set({ requested: true, revision: row.revision + 1 })
            .where("id", "=", row.id)
            .returningAll()
            .executeTakeFirstOrThrow();
        return this.view(row, await wallTime(tx));
      }
      const now = await wallTime(tx);
      row = await tx
        .updateTable("jobs")
        .set({ requested: true, revision: row.revision + 1 })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (row.state !== "running")
        row = await this.finish(tx, row, "cancelled", now, undefined, undefined, cleanupMs);
      return this.view(row, now);
    });
    this.hint(id);
    return result;
  }
  async finish(
    tx: JobsTransaction,
    row: JobRow,
    state: "succeeded" | "failed" | "cancelled",
    now: Date,
    error?: JobError,
    result?: PreparedPayload,
    cleanupMs = 30000,
  ): Promise<JobRow> {
    if (terminal(row)) return row;
    const remote =
      (state === "cancelled" || error?.code === "timeout") &&
      !!this.declaration(row)?.external?.cancel;
    const updated = await tx
      .updateTable("jobs")
      .set({
        state,
        revision: row.revision + 1,
        completed_at: now,
        record_expires_at: new Date(now.getTime() + row.metadata_retention_ms),
        result_expires_at: result ? new Date(now.getTime() + row.result_retention_ms) : null,
        has_result: !!result,
        error: error ?? null,
        claim_token: null,
        incarnation: null,
        claim_kind: null,
        lease_until: null,
        blocked_reason: null,
        remote_status: remote
          ? "pending"
          : state === "cancelled" || error?.code === "timeout"
            ? "unsupported"
            : "not-requested",
        cleanup_deadline: remote ? new Date(now.getTime() + cleanupMs) : null,
      })
      .where("id", "=", row.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await tx
      .deleteFrom("job_payloads")
      .where("job_id", "=", row.id)
      .where("kind", "=", "input")
      .execute();
    return updated;
  }
  live(row: JobRow, claim: ClaimRef, now: Date, kind?: "execute" | "observe"): boolean {
    return (
      !terminal(row) &&
      row.claim_token === claim.token &&
      row.incarnation === claim.incarnation &&
      !!row.lease_until &&
      row.lease_until > now &&
      !!row.deadline &&
      row.deadline > now &&
      (!kind || row.claim_kind === kind)
    );
  }
  async inspect(
    authority: Exclude<OperationAuthority, { source: "request" }>,
  ): Promise<ReturnType<BackgroundAuthorityPort["inspect"]> extends Promise<infer T> ? T : never> {
    if (authority.source === "event-source") throw new Error("Wrong background owner");
    const row = await this.row(authority.jobId);
    if (!row) absent();
    return {
      access: this.scope(row, "observe").access,
      ...(row.connection_id
        ? { connectionId: row.connection_id, authorityGeneration: row.authority_generation! }
        : {}),
      started: row.started_at !== null,
    };
  }
  async lockClaim(
    tx: CoreTransaction,
    authority: Exclude<OperationAuthority, { source: "request" }>,
  ): Promise<void> {
    if (authority.source === "event-source") throw new Error("Wrong background owner");
    const jt = tx as unknown as JobsTransaction;
    const row = await jt
      .selectFrom("jobs")
      .selectAll()
      .where("id", "=", authority.jobId)
      .forUpdate()
      .executeTakeFirst();
    const now = await wallTime(jt);
    const valid =
      row &&
      (authority.source === "remote-cancel"
        ? this.cleanupLive(row, authority.claim, now) && row.cancel_issued_at !== null
        : this.live(row, authority.claim, now));
    if (!valid)
      throw new ServiceError(409, "stale-claim", "Background claim expired or was fenced");
  }
  cleanupLive(row: JobRow, claim: ClaimRef, now: Date): boolean {
    return (
      terminal(row) &&
      row.remote_status === "pending" &&
      row.cleanup_token === claim.token &&
      row.cleanup_incarnation === claim.incarnation &&
      !!row.cleanup_lease &&
      row.cleanup_lease > now &&
      !!row.cleanup_deadline &&
      row.cleanup_deadline > now
    );
  }
  async candidates(kind: "execute" | "observe", limit: number): Promise<JobRow[]> {
    return this.control
      .selectFrom("jobs")
      .selectAll()
      .where("state", "=", kind === "execute" ? "queued" : "waiting-provider")
      .where("due_at", "<=", sql<Date>`clock_timestamp()`)
      .where("claim_token", "is", null)
      .orderBy("due_at")
      .orderBy("submitted_at")
      .orderBy("id")
      .limit(limit)
      .execute();
  }
  async claim(
    hint: JobRow,
    kind: "execute" | "observe",
    incarnation: string,
    leaseMs: number,
  ): Promise<JobRow | null> {
    const declaration = this.declaration(hint);
    if (!declaration || (kind === "observe" && !declaration.external?.observe)) return null;
    try {
      return await this.control.transaction().execute(async (tx) => {
        await this.options.core.connections.lockBackground(
          coreTx(tx),
          this.scope(hint, kind === "execute" ? "start" : "observe"),
        );
        const row = await tx
          .selectFrom("jobs")
          .selectAll()
          .where("id", "=", hint.id)
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (row)
          await this.options.core.connections.lockBackground(
            coreTx(tx),
            this.scope(row, kind === "execute" ? "start" : "observe"),
          );
        const now = await wallTime(tx);
        if (
          !row ||
          terminal(row) ||
          row.requested ||
          row.claim_token ||
          row.state !== (kind === "execute" ? "queued" : "waiting-provider") ||
          row.due_at > now
        )
          return null;
        if (row.deadline && row.deadline <= now) {
          await this.finish(tx, row, "failed", now, {
            code: "timeout",
            message: "Job execution deadline expired",
          });
          return null;
        }
        const registration = await tx
          .selectFrom("provider_registrations")
          .select("config_revision")
          .where("id", "=", row.provider_registration_id)
          .executeTakeFirstOrThrow();
        if (registration.config_revision !== row.provider_revision) {
          if (kind === "execute")
            await this.finish(tx, row, "failed", now, {
              code: "authority-changed",
              message: "Original provider configuration is unavailable",
            });
          return null;
        }
        const token = randomUUID();
        const deadline = row.deadline ?? new Date(now.getTime() + row.execution_seconds * 1000);
        return tx
          .updateTable("jobs")
          .set({
            state: kind === "execute" ? "running" : "waiting-provider",
            revision: row.revision + 1,
            started_at: row.started_at ?? now,
            deadline,
            claim_token: token,
            incarnation,
            claim_kind: kind,
            lease_until: new Date(Math.min(now.getTime() + leaseMs, deadline.getTime())),
            attempts: row.attempts + (kind === "execute" ? 1 : 0),
            blocked_reason: null,
            ...(kind === "execute"
              ? {
                  invocation_token: token,
                  invocation_incarnation: incarnation,
                  callback_correlation: declaration.external?.callback ? randomUUID() : null,
                }
              : {}),
          })
          .where("id", "=", row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      });
    } catch (error) {
      if (!(error instanceof ServiceError) || ![403, 404, 422].includes(error.status)) throw error;
      await this.control.transaction().execute(async (tx) => {
        const row = await tx
          .selectFrom("jobs")
          .selectAll()
          .where("id", "=", hint.id)
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (!row || terminal(row) || row.claim_token || row.revision !== hint.revision) return;
        const now = await wallTime(tx);
        if (row.deadline && row.deadline <= now)
          await this.finish(tx, row, "failed", now, {
            code: "timeout",
            message: "Job execution deadline expired",
          });
        else if (kind === "observe")
          await tx
            .updateTable("jobs")
            .set({
              blocked_reason: "observation-authority-unavailable",
              due_at: new Date(now.getTime() + leaseMs),
              revision: row.revision + 1,
            })
            .where("id", "=", row.id)
            .execute();
        else if (["reauthorization-required", "renewal-uncertain"].includes(error.code))
          await tx
            .updateTable("jobs")
            .set({
              blocked_reason: "reauthorization-required",
              due_at: new Date(now.getTime() + leaseMs),
              revision: row.revision + 1,
            })
            .where("id", "=", row.id)
            .execute();
        else
          await this.finish(tx, row, "failed", now, {
            code: "authority-unavailable",
            message: "Original execution authority is unavailable",
          });
      });
      return null;
    }
  }
  async heartbeat(id: string, claim: ClaimRef, leaseMs: number): Promise<boolean> {
    return this.control.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom("jobs")
        .selectAll()
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      const now = await wallTime(tx);
      if (!row || !this.live(row, claim, now) || row.requested) return false;
      await tx
        .updateTable("jobs")
        .set({ lease_until: new Date(Math.min(now.getTime() + leaseMs, row.deadline!.getTime())) })
        .where("id", "=", id)
        .execute();
      return true;
    });
  }
  validatedProgress(row: JobRow, value: unknown): { value: unknown } {
    const schema = this.declaration(row)?.progressSchema;
    if (!schema) throw new ServiceError(422, "progress-unsupported", "Progress is not declared");
    const progress = z.json().parse(schema.parse(value));
    if (Buffer.byteLength(JSON.stringify(progress)) > 16384)
      throw new ServiceError(422, "progress-too-large", "Progress exceeds its bound");
    return { value: progress };
  }
  async progress(row: JobRow, claim: ClaimRef, value: unknown): Promise<void> {
    const progress = this.validatedProgress(row, value);
    await this.control.transaction().execute(async (tx) => {
      const current = await tx
        .selectFrom("jobs")
        .selectAll()
        .where("id", "=", row.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (!this.live(current, claim, await wallTime(tx)))
        throw new ServiceError(409, "stale-claim", "Progress claim expired");
      await tx
        .updateTable("jobs")
        .set({ progress, revision: current.revision + 1 })
        .where("id", "=", row.id)
        .execute();
    });
    this.hint(row.id);
  }
  async prepareResult(row: JobRow, value: unknown): Promise<PreparedPayload> {
    const declaration = this.declaration(row);
    if (!declaration) throw new Error("Missing retained result schema");
    return this.options.payloads.seal(
      value,
      this.schema(declaration.resultSchema),
      row.result_limit,
      this.binding(row, "result"),
    );
  }
  async prepareTask(row: JobRow, task: ExternalTask): Promise<PreparedPayload> {
    z.string().min(1).max(500).parse(task.externalId);
    if (task.accountKey !== row.account_key || !task.accountKey)
      throw new ServiceError(
        422,
        "task-account-mismatch",
        "Task does not belong to the original account",
      );
    const external = this.declaration(row)?.external;
    if (!external)
      throw new ServiceError(422, "external-task-unsupported", "External tasks are not declared");
    return this.options.payloads.seal(
      task.context,
      this.schema(external.contextSchema),
      external.contextLimitBytes,
      this.binding(row, "task"),
    );
  }
  async task(row: JobRow): Promise<ExternalTask> {
    if (!row.task_id || !row.account_key) throw new Error("Missing original external identity");
    return {
      externalId: row.task_id,
      accountKey: row.account_key,
      context: await this.payload(row, "task"),
    };
  }
  async publish(
    row: JobRow,
    claim: ClaimRef,
    outcome: ExecutionOutcome | ObservationOutcome,
    prepared: { result?: PreparedPayload; task?: PreparedPayload },
    cleanupMs: number,
  ): Promise<boolean> {
    if ((outcome.kind === "complete" || outcome.kind === "succeeded") && !prepared.result)
      throw new Error("A completed Job requires a validated encrypted result");
    try {
      const changed = await this.db.transaction().execute(async (tx) => {
        if (prepared.result) await this.insertPayload(tx, row.id, "result", prepared.result);
        if (prepared.task) await this.insertPayload(tx, row.id, "task", prepared.task);
        const current = await tx
          .selectFrom("jobs")
          .selectAll()
          .where("id", "=", row.id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const now = await wallTime(tx);
        if (!this.live(current, claim, now)) {
          if (outcome.kind === "waiting" && this.canAttachLate(current, claim, now, outcome.task)) {
            await tx
              .updateTable("jobs")
              .set({ task_id: outcome.task.externalId })
              .where("id", "=", row.id)
              .execute();
            return true;
          }
          throw new ServiceError(409, "stale-claim", "Outcome claim expired or was fenced");
        }
        if (outcome.kind === "waiting") {
          if (current.task_id && current.task_id !== outcome.task.externalId)
            throw new ServiceError(409, "task-conflict", "Original task identity cannot change");
          const attached = await tx
            .updateTable("jobs")
            .set({
              task_id: outcome.task.externalId,
              state: "waiting-provider",
              claim_token: null,
              incarnation: null,
              claim_kind: null,
              lease_until: null,
              due_at: this.nextCheck(outcome.nextCheckAt, now, current.deadline!),
              revision: current.revision + 1,
            })
            .where("id", "=", row.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await tx
            .deleteFrom("job_payloads")
            .where("job_id", "=", row.id)
            .where("kind", "=", "input")
            .execute();
          if (current.requested)
            await this.finish(tx, attached, "cancelled", now, undefined, undefined, cleanupMs);
        } else if (outcome.kind === "pending") {
          await tx
            .updateTable("jobs")
            .set({
              claim_token: null,
              incarnation: null,
              claim_kind: null,
              lease_until: null,
              due_at: this.nextCheck(outcome.nextCheckAt, now, current.deadline!),
              revision: current.revision + 1,
            })
            .where("id", "=", row.id)
            .execute();
        } else if (outcome.kind === "complete" || outcome.kind === "succeeded")
          await this.finish(tx, current, "succeeded", now, undefined, prepared.result, cleanupMs);
        else {
          const error = safeError.parse(outcome.error);
          const delay =
            current.claim_kind === "execute" &&
            !current.task_id &&
            "retryable" in outcome &&
            outcome.retryable === true
              ? this.declaration(current)?.retry?.delaysMs[current.attempts - 1]
              : undefined;
          if (
            delay !== undefined &&
            !current.requested &&
            now.getTime() + delay < current.deadline!.getTime()
          ) {
            if (prepared.result)
              await tx
                .deleteFrom("job_payloads")
                .where("job_id", "=", row.id)
                .where("kind", "=", "result")
                .execute();
            await tx
              .updateTable("jobs")
              .set({
                state: "queued",
                claim_token: null,
                incarnation: null,
                claim_kind: null,
                lease_until: null,
                due_at: new Date(now.getTime() + delay),
                error,
                revision: current.revision + 1,
              })
              .where("id", "=", row.id)
              .execute();
          } else
            await this.finish(
              tx,
              current,
              current.requested ? "cancelled" : "failed",
              now,
              error,
              prepared.result,
              cleanupMs,
            );
        }
        return true;
      });
      if (changed) this.hint(row.id);
      return changed;
    } catch (error) {
      if (error instanceof ServiceError && error.code === "stale-claim") return false;
      if ((error as { code?: string }).code === "23505") {
        const fresh = await this.row(row.id);
        if (
          fresh &&
          (terminal(fresh) ||
            (outcome.kind === "waiting" && fresh.task_id === outcome.task.externalId))
        )
          return false;
      }
      throw error;
    } finally {
      this.options.payloads.releasePrepared(prepared.result);
      this.options.payloads.releasePrepared(prepared.task);
    }
  }
  nextCheck(value: string | undefined, now: Date, deadline: Date): Date {
    // Callback-only tasks have no observation scan until their absolute deadline.
    if (value === undefined) return deadline;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date <= now)
      throw new ServiceError(422, "invalid-next-check", "Observation must schedule a future check");
    return new Date(Math.min(date.getTime(), deadline.getTime()));
  }
  canAttachLate(row: JobRow, claim: ClaimRef, now: Date, task: ExternalTask): boolean {
    return (
      terminal(row) &&
      row.remote_status === "pending" &&
      !!row.cleanup_deadline &&
      row.cleanup_deadline > now &&
      !!this.declaration(row)?.external?.cancel &&
      row.invocation_token === claim.token &&
      row.invocation_incarnation === claim.incarnation &&
      task.accountKey === row.account_key &&
      (!row.task_id || row.task_id === task.externalId)
    );
  }
  async callback(
    declaration: JobDeclaration,
    raw: Uint8Array,
    headers: Headers,
    cleanupMs = 30000,
  ): Promise<"accepted" | "duplicate" | "late"> {
    const callback = declaration.external?.callback;
    if (!callback) absent();
    const evidence = await callback.verify(raw, headers);
    const bound = (row: JobRow) =>
      row.callback_correlation === evidence.correlation &&
      row.provider_registration_id === declaration.providerRegistrationId &&
      row.capability_id === declaration.ref.id &&
      row.capability_version === declaration.ref.version &&
      row.account_key === evidence.task.accountKey &&
      (!row.task_id || row.task_id === evidence.task.externalId);
    const hint = await this.db
      .selectFrom("jobs")
      .selectAll()
      .where("callback_correlation", "=", evidence.correlation)
      .where("provider_registration_id", "=", declaration.providerRegistrationId)
      .where("capability_id", "=", declaration.ref.id)
      .where("capability_version", "=", declaration.ref.version)
      .executeTakeFirst();
    if (!hint || !bound(hint)) absent();
    const progress =
      evidence.outcome.kind === "pending" && evidence.outcome.progress !== undefined
        ? this.validatedProgress(hint, evidence.outcome.progress)
        : undefined;
    let task: PreparedPayload | undefined;
    let result: PreparedPayload | undefined;
    try {
      task = !hint.task_id ? await this.prepareTask(hint, evidence.task) : undefined;
      result =
        !terminal(hint) &&
        (evidence.outcome.kind === "succeeded" ||
          (evidence.outcome.kind === "failed" && evidence.outcome.result !== undefined))
          ? await this.prepareResult(hint, evidence.outcome.result)
          : undefined;
      return await this.db.transaction().execute(async (tx) => {
        // Another attachment can win while payload preparation runs outside locks.
        // Preserve its context, then check its authoritative binding under the Job lock.
        if (task)
          await tx
            .insertInto("job_payloads")
            .values({ ...task, job_id: hint.id, kind: "task" })
            .onConflict((oc) => oc.columns(["job_id", "kind"]).doNothing())
            .execute();
        if (result) await this.insertPayload(tx, hint.id, "result", result);
        const row = await tx
          .selectFrom("jobs")
          .selectAll()
          .where("id", "=", hint.id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const now = await wallTime(tx);
        if (!bound(row)) absent();
        if (terminal(row)) {
          if (
            !row.task_id &&
            row.remote_status === "pending" &&
            row.cleanup_deadline &&
            row.cleanup_deadline > now &&
            this.declaration(row)?.external?.cancel
          ) {
            await tx
              .updateTable("jobs")
              .set({ task_id: evidence.task.externalId })
              .where("id", "=", row.id)
              .execute();
            return "late";
          }
          throw new ServiceError(
            409,
            "callback-late",
            row.task_id === evidence.task.externalId ? "duplicate" : "late",
          );
        }
        if (!row.started_at || !row.deadline) absent();
        if (row.deadline <= now) throw new ServiceError(409, "callback-late", "late");
        const attached = await tx
          .updateTable("jobs")
          .set({
            task_id: evidence.task.externalId,
            state: "waiting-provider",
            claim_token: null,
            incarnation: null,
            claim_kind: null,
            lease_until: null,
            revision: row.revision + 1,
            ...(progress ? { progress } : {}),
            due_at:
              evidence.outcome.kind === "pending"
                ? this.nextCheck(evidence.outcome.nextCheckAt, now, row.deadline)
                : row.due_at,
          })
          .where("id", "=", row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await tx
          .deleteFrom("job_payloads")
          .where("job_id", "=", row.id)
          .where("kind", "=", "input")
          .execute();
        if (evidence.outcome.kind === "succeeded")
          await this.finish(tx, attached, "succeeded", now, undefined, result);
        if (evidence.outcome.kind === "failed")
          await this.finish(
            tx,
            attached,
            "failed",
            now,
            safeError.parse(evidence.outcome.error),
            result,
          );
        if (attached.requested && evidence.outcome.kind === "pending")
          await this.finish(tx, attached, "cancelled", now, undefined, undefined, cleanupMs);
        return "accepted";
      });
    } catch (error) {
      if (error instanceof ServiceError && error.code === "callback-late")
        return error.message === "duplicate" ? "duplicate" : "late";
      // A result conflict is a duplicate only after its terminal commit is confirmed.
      if ((error as { code?: string }).code === "23505") {
        return await this.db.transaction().execute(async (tx) => {
          const row = await tx
            .selectFrom("jobs")
            .selectAll()
            .where("id", "=", hint.id)
            .forUpdate()
            .executeTakeFirst();
          if (!row || !bound(row)) absent();
          if (row.task_id === evidence.task.externalId && terminal(row))
            return "duplicate" as const;
          throw error;
        });
      }
      throw error;
    } finally {
      this.options.payloads.releasePrepared(result);
      this.options.payloads.releasePrepared(task);
      this.hint(hint.id);
    }
  }
  async controls(limit: number, cleanupMs: number): Promise<number> {
    // Each branch uses its own partial index and a bound, even under execution saturation.
    const candidates = await sql<{ id: string }>`
      (select id from jobs where completed_at is null and deadline<=clock_timestamp() order by deadline,id limit ${limit}) union
      (select id from jobs where claim_token is not null and lease_until<=clock_timestamp() order by lease_until,id limit ${limit}) union
      (select id from jobs where completed_at is null and requested order by due_at,id limit ${limit}) union
      (select id from jobs where remote_status='pending' and cleanup_deadline<=clock_timestamp() order by cleanup_deadline,id limit ${limit}) union
      (select id from jobs where remote_status='pending' and cleanup_lease<=clock_timestamp() order by cleanup_lease,id limit ${limit})`.execute(
      this.control,
    );
    let changed = 0;
    for (const candidate of candidates.rows) {
      const did = await this.control.transaction().execute(async (tx) => {
        const row = await tx
          .selectFrom("jobs")
          .selectAll()
          .where("id", "=", candidate.id)
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (!row) return false;
        const now = await wallTime(tx);
        if (!terminal(row)) {
          if (row.deadline && row.deadline <= now)
            await this.finish(
              tx,
              row,
              "failed",
              now,
              { code: "timeout", message: "Job execution deadline expired" },
              undefined,
              cleanupMs,
            );
          else if (row.requested)
            await this.finish(tx, row, "cancelled", now, undefined, undefined, cleanupMs);
          else if (row.claim_token && row.lease_until && row.lease_until <= now) {
            if (row.claim_kind === "execute")
              await this.finish(tx, row, "failed", now, {
                code: "interrupted",
                message: "Execution was interrupted; external effects may be unknown",
              });
            else
              await tx
                .updateTable("jobs")
                .set({
                  claim_token: null,
                  incarnation: null,
                  claim_kind: null,
                  lease_until: null,
                  due_at: now,
                  revision: row.revision + 1,
                })
                .where("id", "=", row.id)
                .execute();
          } else return false;
        } else if (
          row.remote_status === "pending" &&
          ((row.cleanup_deadline && row.cleanup_deadline <= now) ||
            (row.cleanup_lease && row.cleanup_lease <= now))
        ) {
          await tx
            .updateTable("jobs")
            .set({
              revision: row.revision + 1,
              remote_status: row.cancel_issued_at
                ? "unconfirmed"
                : row.cleanup_deadline! <= now
                  ? "unavailable"
                  : "pending",
              cleanup_token: null,
              cleanup_incarnation: null,
              cleanup_lease: null,
            })
            .where("id", "=", row.id)
            .execute();
        } else return false;
        return true;
      });
      if (did) {
        changed++;
        this.hint(candidate.id);
      }
    }
    return changed;
  }
  async cleanupCandidates(limit: number): Promise<JobRow[]> {
    return this.control
      .selectFrom("jobs")
      .selectAll()
      .where("remote_status", "=", "pending")
      .where("task_id", "is not", null)
      .where("cleanup_token", "is", null)
      .where("cancel_issued_at", "is", null)
      .where("cleanup_deadline", ">", sql<Date>`clock_timestamp()`)
      .orderBy("cleanup_deadline")
      .orderBy("id")
      .limit(limit)
      .execute();
  }
  async claimCleanup(hint: JobRow, incarnation: string, leaseMs: number): Promise<JobRow | null> {
    if (!this.declaration(hint)?.external?.cancel) return null;
    try {
      return await this.control.transaction().execute(async (tx) => {
        await this.options.core.connections.lockBackground(
          coreTx(tx),
          this.scope(hint, "remote-cancel"),
        );
        const row = await tx
          .selectFrom("jobs")
          .selectAll()
          .where("id", "=", hint.id)
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        const now = await wallTime(tx);
        if (
          !row ||
          !terminal(row) ||
          row.remote_status !== "pending" ||
          !row.task_id ||
          row.cleanup_token ||
          row.cancel_issued_at ||
          !row.cleanup_deadline ||
          row.cleanup_deadline <= now
        )
          return null;
        return tx
          .updateTable("jobs")
          .set({
            cleanup_token: randomUUID(),
            cleanup_incarnation: incarnation,
            cleanup_lease: new Date(
              Math.min(now.getTime() + leaseMs, row.cleanup_deadline.getTime()),
            ),
          })
          .where("id", "=", row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      });
    } catch (error) {
      if (!(error instanceof ServiceError) || ![403, 404, 422].includes(error.status)) throw error;
      await this.control
        .updateTable("jobs")
        .set({ remote_status: "unavailable", revision: sql<number>`revision+1` })
        .where("id", "=", hint.id)
        .where("remote_status", "=", "pending")
        .where("cleanup_token", "is", null)
        .execute();
      return null;
    }
  }
  async issueCancel(row: JobRow, claim: ClaimRef): Promise<boolean> {
    return this.control.transaction().execute(async (tx) => {
      await this.options.core.connections.lockBackground(
        coreTx(tx),
        this.scope(row, "remote-cancel"),
      );
      const current = await tx
        .selectFrom("jobs")
        .selectAll()
        .where("id", "=", row.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      await this.options.core.connections.lockBackground(
        coreTx(tx),
        this.scope(current, "remote-cancel"),
      );
      const now = await wallTime(tx);
      if (!this.cleanupLive(current, claim, now) || current.cancel_issued_at) return false;
      await tx
        .updateTable("jobs")
        .set({ cancel_issued_at: now })
        .where("id", "=", row.id)
        .execute();
      return true;
    });
  }
  async cancelEvidence(
    row: JobRow,
    claim: ClaimRef,
    status: "confirmed" | "unconfirmed" | "unavailable",
  ): Promise<void> {
    await this.control.transaction().execute(async (tx) => {
      const current = await tx
        .selectFrom("jobs")
        .selectAll()
        .where("id", "=", row.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (!this.cleanupLive(current, claim, await wallTime(tx)) || !current.cancel_issued_at)
        return;
      await tx
        .updateTable("jobs")
        .set({
          remote_status: status,
          revision: current.revision + 1,
          cleanup_token: null,
          cleanup_incarnation: null,
          cleanup_lease: null,
        })
        .where("id", "=", row.id)
        .execute();
    });
    this.hint(row.id);
  }
  async retain(limit: number): Promise<void> {
    const ids = await sql<{
      id: string;
    }>`(select id from jobs where has_result and result_expires_at<=clock_timestamp() order by result_expires_at,id limit ${limit}) union (select id from jobs where completed_at is not null and record_expires_at<=clock_timestamp() order by record_expires_at,id limit ${limit})`.execute(
      this.control,
    );
    for (const { id } of ids.rows)
      await this.control.transaction().execute(async (tx) => {
        const row = await tx
          .selectFrom("jobs")
          .selectAll()
          .where("id", "=", id)
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (!row) return;
        const now = await wallTime(tx);
        if (terminal(row) && row.record_expires_at! <= now)
          await tx.deleteFrom("jobs").where("id", "=", id).execute();
        else if (row.has_result && row.result_expires_at! <= now) {
          await tx
            .deleteFrom("job_payloads")
            .where("job_id", "=", id)
            .where("kind", "=", "result")
            .execute();
          await tx.updateTable("jobs").set({ has_result: false }).where("id", "=", id).execute();
        }
      });
  }
  async assertCompatibility(): Promise<void> {
    const active = await this.control
      .selectFrom("jobs")
      .select(["capability_id", "capability_version"])
      .where("completed_at", "is", null)
      .distinct()
      .execute();
    if (active.some((row) => !this.declaration(row)))
      throw new ServiceError(
        503,
        "job-version-unavailable",
        "An active Job requires its retained executable version",
      );
  }
  async required(): Promise<boolean> {
    if (this.options.declarations.some((d) => d.acceptsSubmissions !== false)) return true;
    return !!(await this.control.selectFrom("jobs").select("id").limit(1).executeTakeFirst());
  }
  async nextDue(): Promise<Date | null> {
    const result = await sql<{ due: Date | null }>`select min(due) as due from (
      (select due_at as due from jobs where state in ('queued','waiting-provider') and claim_token is null order by due_at limit 1) union all
      (select lease_until from jobs where claim_token is not null order by lease_until limit 1) union all
      (select deadline from jobs where completed_at is null and deadline is not null order by deadline limit 1) union all
      (select result_expires_at from jobs where has_result order by result_expires_at limit 1) union all
      (select record_expires_at from jobs where completed_at is not null order by record_expires_at limit 1) union all
      (select cleanup_deadline from jobs where remote_status='pending' order by cleanup_deadline limit 1) union all
      (select cleanup_lease from jobs where remote_status='pending' and cleanup_lease is not null order by cleanup_lease limit 1)
    ) due_times`.execute(this.control);
    return result.rows[0]?.due ?? null;
  }
  async list(
    access: AccessContext,
    filters: {
      appId?: string;
      state?: JobView["state"];
      capability?: string;
      next?: string;
      limit?: number;
    } = {},
  ): Promise<{ items: JobView[]; next?: string }> {
    const limit = z
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(filters.limit ?? 50);
    const filterKey = JSON.stringify([
      filters.appId ?? null,
      filters.state ?? null,
      filters.capability ?? null,
    ]);
    let after: { at: string; id: string; filter: string } | undefined;
    if (filters.next) {
      if (filters.next.length > 2048)
        throw new ServiceError(400, "invalid-continuation", "Invalid continuation");
      try {
        const envelope = JSON.parse(Buffer.from(filters.next, "base64url").toString());
        const plaintext = this.options.core.secrets.open(envelope, {
          kind: "job-cursor",
          id: access.ownerId,
          revision: "1",
        });
        after = z
          .strictObject({ at: z.iso.datetime(), id: opaqueId, filter: z.string() })
          .parse(JSON.parse(plaintext.toString()));
      } catch {
        throw new ServiceError(400, "invalid-continuation", "Invalid continuation");
      }
      if (after.filter !== filterKey)
        throw new ServiceError(400, "invalid-continuation", "Continuation filters changed");
    }
    let query = this.control
      .selectFrom("jobs")
      .selectAll()
      .where("owner_id", "=", access.ownerId)
      .where((eb) =>
        eb.or([
          eb("record_expires_at", "is", null),
          eb("record_expires_at", ">", sql<Date>`clock_timestamp()`),
        ]),
      );
    if (filters.appId) query = query.where("app_id", "=", opaqueId.parse(filters.appId));
    if (filters.state) query = query.where("state", "=", filters.state);
    if (filters.capability)
      query = query.where("capability_id", "=", opaqueId.parse(filters.capability));
    if (after)
      query = query.where((eb) =>
        eb.or([
          eb("submitted_at", ">", new Date(after!.at)),
          eb.and([eb("submitted_at", "=", new Date(after!.at)), eb("id", ">", after!.id)]),
        ]),
      );
    const rows = await query
      .orderBy("submitted_at")
      .orderBy("id")
      .limit(limit + 1)
      .execute();
    if (!rows.length)
      await this.control
        .transaction()
        .execute((tx) => this.options.core.access.lockAuthority(coreTx(tx), access));
    const items: JobView[] = [];
    for (const row of rows.slice(0, limit)) {
      try {
        items.push(await this.get(access, row.id));
      } catch (error) {
        if (!(error instanceof ServiceError) || error.status !== 404) throw error;
      }
    }
    const last = rows[Math.min(limit, rows.length) - 1];
    return {
      items,
      ...(rows.length > limit && last
        ? {
            next: Buffer.from(
              JSON.stringify(
                this.options.core.secrets.seal(
                  Buffer.from(
                    JSON.stringify({
                      at: last.submitted_at.toISOString(),
                      id: last.id,
                      filter: filterKey,
                    }),
                  ),
                  { kind: "job-cursor", id: access.ownerId, revision: "1" },
                ),
              ),
            ).toString("base64url"),
          }
        : {}),
    };
  }
}
