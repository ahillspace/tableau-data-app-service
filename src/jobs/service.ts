import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { sql } from "kysely";
import type { JobHandlerDefinition } from "../connections/extensions.ts";
import type { CheckoutCaller, ConnectionService } from "../connections/service.ts";
import { trustedSiteFor } from "../identity/directory.ts";
import { actorOf, type Identity, type Principal } from "../identity/types.ts";
import { writeAudit } from "../persistence/audit.ts";
import {
  type Db,
  isUniqueViolation,
  type Queryable,
  transaction,
} from "../persistence/database.ts";
import type { Clock } from "../platform/clock.ts";
import { invalid, notFound, ServiceError, type ServiceErrorBody } from "../platform/errors.ts";
import type { Log } from "../platform/log.ts";
import { hashToken, sameSecret } from "../platform/secrets.ts";
import {
  FINISHED_STATES,
  type Job,
  type JobLimits,
  type JobState,
  type Submission,
} from "./types.ts";

const KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;
const REMOTE_CANCEL_MS = 10_000;

/** The canonical JSON of a value and its byte length, or a field error when it is not JSON. */
export function canonicalJson(value: unknown): { text: string; bytes: number } {
  let text: string | undefined;
  try {
    text = canonicalize(value);
  } catch {
    text = undefined;
  }
  if (text === undefined) throw invalid([{ path: "input", rule: "json" }], "The input is not JSON");
  return { text, bytes: Buffer.byteLength(text) };
}

export function inputHash(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex");
}

/** The limits a handler runs under: the installation's, lowered by any the handler declares. */
export function limitsFor(installation: JobLimits, handler: JobHandlerDefinition): JobLimits {
  const own = handler.limits ?? {};
  return {
    ...installation,
    inputBytes: Math.min(installation.inputBytes, own.inputBytes ?? Number.POSITIVE_INFINITY),
    resultBytes: Math.min(installation.resultBytes, own.resultBytes ?? Number.POSITIVE_INFINITY),
    runtimeSeconds: Math.min(
      installation.runtimeSeconds,
      own.runtimeSeconds ?? Number.POSITIVE_INFINITY,
    ),
  };
}

const JOB_COLUMNS = [
  "j.id",
  "j.handler",
  "j.definition_id",
  "j.app_id",
  "j.submission_key",
  "j.input_hash",
  "j.state",
  "j.progress",
  "j.attempt",
  "j.external_task_id",
  "j.cancel_requested",
  "j.remote_effects_unknown",
  "j.error",
  "j.created_at",
  "j.started_at",
  "j.finished_at",
  "j.result_expires_at",
  "i.deployment_id",
  "i.site_id",
  "i.user_id",
] as const;

type ReadRow = {
  id: string;
  handler: string;
  definition_id: string | null;
  app_id: string;
  submission_key: string;
  input_hash: string;
  state: JobState;
  progress: unknown;
  attempt: number;
  external_task_id: string | null;
  cancel_requested: boolean;
  remote_effects_unknown: boolean;
  error: unknown;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  result_expires_at: Date | null;
  deployment_id: string;
  site_id: string;
  user_id: string;
};

function toJob(row: ReadRow, resultAvailable: boolean): Job {
  return {
    id: row.id,
    handler: row.handler,
    definitionId: row.definition_id ?? "",
    owner: { deploymentId: row.deployment_id, siteId: row.site_id, userId: row.user_id },
    appId: row.app_id,
    submissionKey: row.submission_key,
    state: row.state,
    attempt: row.attempt,
    ...(row.progress !== null && row.progress !== undefined ? { progress: row.progress } : {}),
    ...(row.external_task_id ? { externalTaskId: row.external_task_id } : {}),
    cancelRequested: row.cancel_requested,
    remoteEffectsUnknown: row.remote_effects_unknown,
    ...(row.state === "succeeded" && row.result_expires_at
      ? { result: { available: resultAvailable, expiresAt: row.result_expires_at.toISOString() } }
      : {}),
    ...(row.error ? { error: row.error as ServiceErrorBody["error"] } : {}),
    createdAt: row.created_at.toISOString(),
    ...(row.started_at ? { startedAt: row.started_at.toISOString() } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at.toISOString() } : {}),
  };
}

export type JobsOptions = {
  db: Db;
  connections: ConnectionService;
  limits: JobLimits;
  publicOrigin: string;
  clock: Clock;
  log: Log;
};

/** Where a Job's checkout comes from: the owner's identity and the trusted site it still belongs to. */
export async function ownerCaller(db: Queryable, ownerIdentityId: string): Promise<CheckoutCaller> {
  const owner = await db
    .selectFrom("identities")
    .select(["deployment_id", "site_id", "user_id"])
    .where("id", "=", ownerIdentityId)
    .executeTakeFirst();
  const identity: Identity | undefined = owner
    ? { deploymentId: owner.deployment_id, siteId: owner.site_id, userId: owner.user_id }
    : undefined;
  const site = identity ? await trustedSiteFor(db, identity) : undefined;
  if (!site)
    throw new ServiceError(
      403,
      "site-not-trusted",
      "The Job owner's Tableau site is no longer trusted",
      {
        upstream: "not-sent",
      },
    );
  return { identityId: ownerIdentityId, trustedSiteId: site.id };
}

/** Jobs: admission, reading, cancellation and external task callbacks. Workers run them. */
export class JobService {
  readonly #db: Db;
  readonly #connections: ConnectionService;
  readonly #limits: JobLimits;
  readonly #origin: string;
  readonly #clock: Clock;
  readonly #log: Log;

  constructor(options: JobsOptions) {
    this.#db = options.db;
    this.#connections = options.connections;
    this.#limits = options.limits;
    this.#origin = options.publicOrigin;
    this.#clock = options.clock;
    this.#log = options.log;
  }

  get limits(): JobLimits {
    return this.#limits;
  }

  #handler(name: string): { handler: JobHandlerDefinition } {
    const found = this.#connections.definitions.extensions.handler(name);
    if (!found) throw notFound("handler-not-found", `No Job handler is named ${name}`);
    return found;
  }

  callbackUrl(jobId: string): string {
    return `${this.#origin}/v1/jobs/callbacks/${jobId}`;
  }

  /**
   * Admits a Job. The row is committed before this returns, so a caller told `accepted` has a Job.
   * The same submission key with the same input returns the existing Job.
   */
  async submit(
    principal: Principal,
    submission: Submission,
  ): Promise<{ job: Job; created: boolean }> {
    if (principal.kind !== "app" || !principal.appId)
      throw new ServiceError(
        403,
        "app-session-required",
        "Jobs are submitted from a Data App session",
      );
    const errors = [];
    if (typeof submission.handler !== "string" || !submission.handler)
      errors.push({ path: "handler", rule: "required" });
    if (typeof submission.definitionId !== "string" || !submission.definitionId)
      errors.push({ path: "definition", rule: "required" });
    if (typeof submission.submissionKey !== "string" || !KEY_PATTERN.test(submission.submissionKey))
      errors.push({ path: "key", rule: "printable-1-200" });
    if (errors.length) throw invalid(errors);
    const { handler } = this.#handler(submission.handler);
    const limits = limitsFor(this.#limits, handler);
    const canonical = canonicalJson(submission.input ?? null);
    if (canonical.bytes > limits.inputBytes)
      throw new ServiceError(
        413,
        "input-too-large",
        `The input is larger than ${limits.inputBytes} bytes`,
      );
    const inputErrors = handler.validateInput?.(submission.input ?? null) ?? [];
    if (inputErrors.length) throw invalid(inputErrors, "The input is invalid");
    const hash = inputHash(canonical.text);

    const existing = await this.#bySubmissionKey(
      principal.identityId,
      handler.name,
      submission.submissionKey,
    );
    if (existing)
      return { job: await this.#existing(existing, hash, submission.definitionId), created: false };

    // The caller must be able to use the definition now; the Job later runs with the owner's current connection.
    await this.#connections.checkout(principal, submission.definitionId);
    const now = this.#clock.now();
    let id: string;
    try {
      const row = await this.#db
        .insertInto("jobs")
        .values({
          handler: handler.name,
          definition_id: submission.definitionId,
          owner_identity_id: principal.identityId,
          app_id: principal.appId,
          submission_key: submission.submissionKey,
          input_hash: hash,
          input: canonical.text,
          state: "queued",
          attempt: 0,
          run_after: now,
          cancel_requested: false,
          remote_effects_unknown: false,
          created_at: now,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      id = row.id;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.#bySubmissionKey(
        principal.identityId,
        handler.name,
        submission.submissionKey,
      );
      if (!raced) throw error;
      return { job: await this.#existing(raced, hash, submission.definitionId), created: false };
    }
    this.#log.info("job admitted", {
      jobId: id,
      handler: handler.name,
      definitionId: submission.definitionId,
    });
    return { job: (await this.#read(id)) as Job, created: true };
  }

  async #existing(row: ReadRow, hash: string, definitionId: string): Promise<Job> {
    if (row.input_hash !== hash || row.definition_id !== definitionId)
      throw new ServiceError(
        409,
        "submission-key-conflict",
        "This submission key was used with different input",
      );
    return toJob(row, await this.#resultAvailable(row));
  }

  #query(db: Queryable = this.#db) {
    return db
      .selectFrom("jobs as j")
      .innerJoin("identities as i", "i.id", "j.owner_identity_id")
      .select(JOB_COLUMNS);
  }

  async #bySubmissionKey(
    owner: string,
    handler: string,
    key: string,
  ): Promise<ReadRow | undefined> {
    return (await this.#query()
      .where("j.owner_identity_id", "=", owner)
      .where("j.handler", "=", handler)
      .where("j.submission_key", "=", key)
      .executeTakeFirst()) as ReadRow | undefined;
  }

  async #resultAvailable(row: Pick<ReadRow, "id" | "state">): Promise<boolean> {
    if (row.state !== "succeeded") return false;
    const result = await this.#db
      .selectFrom("job_results")
      .select("job_id")
      .where("job_id", "=", row.id)
      .where("expires_at", ">", this.#clock.now())
      .executeTakeFirst();
    return result !== undefined;
  }

  async #read(id: string, owner?: string): Promise<Job | undefined> {
    let query = this.#query().where("j.id", "=", id);
    if (owner) query = query.where("j.owner_identity_id", "=", owner);
    const row = (await query.executeTakeFirst()) as ReadRow | undefined;
    return row ? toJob(row, await this.#resultAvailable(row)) : undefined;
  }

  /** The owner reads their Job from any Data App; no connection is needed. */
  async get(principal: Principal, id: string): Promise<Job> {
    const job = isUuid(id) ? await this.#read(id, principal.identityId) : undefined;
    if (!job) throw notFound("job-not-found", "No such Job");
    return job;
  }

  async list(filter: {
    owner?: string;
    state?: string | undefined;
    handler?: string | undefined;
    limit?: number | undefined;
  }): Promise<Job[]> {
    let query = this.#query()
      .orderBy("j.created_at", "desc")
      .limit(Math.min(Math.max(filter.limit ?? 100, 1), 1000));
    if (filter.owner) query = query.where("j.owner_identity_id", "=", filter.owner);
    if (filter.state) query = query.where("j.state", "=", filter.state as JobState);
    if (filter.handler) query = query.where("j.handler", "=", filter.handler);
    const rows = (await query.execute()) as ReadRow[];
    const now = this.#clock.now();
    const succeeded = rows.filter((r) => r.state === "succeeded").map((r) => r.id);
    const available = new Set(
      succeeded.length
        ? (
            await this.#db
              .selectFrom("job_results")
              .select("job_id")
              .where("job_id", "in", succeeded)
              .where("expires_at", ">", now)
              .execute()
          ).map((r) => r.job_id)
        : [],
    );
    return rows.map((r) => toJob(r, available.has(r.id)));
  }

  listOwn(principal: Principal, filter: { state?: string; limit?: number } = {}): Promise<Job[]> {
    return this.list({ ...filter, owner: principal.identityId });
  }

  /** A finished Job's result. A record that outlived its result says `result-expired`. */
  async result(principal: Principal, id: string): Promise<unknown> {
    const job = await this.get(principal, id);
    if (!FINISHED_STATES.includes(job.state))
      throw new ServiceError(409, "job-not-finished", "The Job has not finished");
    if (job.state !== "succeeded")
      throw new ServiceError(409, "job-has-no-result", `The Job ended ${job.state}`);
    const row = await this.#db
      .selectFrom("job_results")
      .select(["result", "expires_at"])
      .where("job_id", "=", id)
      .executeTakeFirst();
    if (!row || row.expires_at.getTime() <= this.#clock.now().getTime())
      throw new ServiceError(410, "result-expired", "The Job's result is no longer kept");
    return row.result;
  }

  /** The owner cancels their own Job. */
  async cancelOwn(principal: Principal, id: string): Promise<Job> {
    await this.get(principal, id);
    return this.#cancel(id, actorOf(principal));
  }

  /** An operator cancels any Job. */
  async cancelAny(operator: Principal, id: string): Promise<Job> {
    if (!isUuid(id) || !(await this.#read(id))) throw notFound("job-not-found", "No such Job");
    const job = await this.#cancel(id, actorOf(operator));
    await writeAudit(this.#db, {
      actor: actorOf(operator),
      action: "job.cancel",
      target: id,
      detail: { state: job.state },
    });
    return job;
  }

  /**
   * A queued or waiting Job ends at once. A running Job's worker sees the request on its next lease
   * renewal and aborts the handler; the Job ends `cancelled` when the handler returns, or when it
   * asks to wait. The row is locked while the state is read, so a cancel never falls between a
   * running Job's check and its move to waiting.
   */
  async #cancel(id: string, actor: string): Promise<Job> {
    const now = this.#clock.now();
    const ended = await transaction(this.#db, async (tx) => {
      const row = await tx
        .selectFrom("jobs")
        .select([
          "state",
          "handler",
          "external_task_id",
          "owner_identity_id",
          "definition_id",
          "earlier_effects_unknown",
        ])
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return undefined;
      if (row.state === "running") {
        await tx.updateTable("jobs").set({ cancel_requested: true }).where("id", "=", id).execute();
        return undefined;
      }
      if (row.state !== "queued" && row.state !== "waiting") return undefined;
      // A Job that has started an external task (waiting on it, or queued to check it) may still
      // have that task running.
      const remote = row.state === "waiting" || row.external_task_id !== null;
      await tx
        .updateTable("jobs")
        .set({
          state: "cancelled",
          cancel_requested: true,
          remote_effects_unknown: remote || row.earlier_effects_unknown,
          callback_verifier_hash: null,
          resume: null,
          resuming: null,
          lease_owner: null,
          lease_expires_at: null,
          finished_at: now,
          record_expires_at: new Date(now.getTime() + this.#limits.recordRetentionSeconds * 1000),
        })
        .where("id", "=", id)
        .execute();
      return { ...row, remote };
    });
    if (ended) {
      this.#log.info("job cancelled", { jobId: id, actor });
      if (ended.remote && ended.external_task_id && ended.definition_id)
        await this.cancelExternalTask(id, {
          handler: ended.handler,
          externalTaskId: ended.external_task_id,
          owner: ended.owner_identity_id,
          definitionId: ended.definition_id,
        });
    }
    return (await this.#read(id)) as Job;
  }

  /**
   * Asks a cancelled Job's handler to stop its external task. Success settles the task, so the Job's
   * remote effects are unknown afterwards only if an earlier attempt left them so; failure is logged
   * and the flag stays.
   */
  async cancelExternalTask(
    id: string,
    task: { handler: string; externalTaskId: string; owner: string; definitionId: string },
  ): Promise<void> {
    const handler = this.#connections.definitions.extensions.handler(task.handler)?.handler;
    if (!handler?.cancel) return;
    const signal = AbortSignal.timeout(REMOTE_CANCEL_MS);
    try {
      const caller = await ownerCaller(this.#db, task.owner);
      const definition = await this.#connections.definitions.get(task.definitionId);
      if (!definition) return;
      await handler.cancel({
        externalTaskId: task.externalTaskId,
        checkout: () => this.#connections.checkout(caller, task.definitionId, signal),
        fetch: this.#connections.extensionContext(definition, signal).fetch,
        signal,
      });
      await this.#db
        .updateTable("jobs")
        .set({ remote_effects_unknown: sql<boolean>`earlier_effects_unknown` })
        .where("id", "=", id)
        .execute();
    } catch (error) {
      this.#log.warn("remote cancel failed", { jobId: id, handler: task.handler, error });
    }
  }

  /**
   * An external task's callback. The verifier is single use. A Job that is still running (the task
   * finished before the wait was recorded) keeps the body and resumes as soon as the wait is recorded.
   */
  async callback(id: string, verifier: string | undefined, body: unknown): Promise<void> {
    const rejected = (status: number, reason: string) => {
      this.#log.warn("job callback rejected", { jobId: id, reason });
      return new ServiceError(
        status,
        "job-callback-invalid",
        "The callback does not match a waiting Job",
      );
    };
    if (!isUuid(id)) throw rejected(404, "unknown-job");
    const row = await this.#db
      .selectFrom("jobs")
      .select(["state", "callback_verifier_hash", "handler"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) throw rejected(404, "unknown-job");
    if (FINISHED_STATES.includes(row.state)) throw rejected(404, "finished");
    if (
      !verifier ||
      !row.callback_verifier_hash ||
      !sameSecret(hashToken(verifier), row.callback_verifier_hash)
    )
      throw rejected(401, "verifier-mismatch");
    const limit = limitsFor(this.#limits, this.#handler(row.handler).handler).inputBytes;
    const canonical = canonicalJson(body ?? null);
    if (canonical.bytes > limit)
      throw new ServiceError(
        413,
        "input-too-large",
        `The callback body is larger than ${limit} bytes`,
      );
    const now = this.#clock.now();
    const updated = await this.#db
      .updateTable("jobs")
      .set({
        resume: canonical.text,
        callback_verifier_hash: null,
        state: sql<JobState>`case when state = 'waiting' then 'queued' else state end`,
        run_after: sql<Date>`case when state = 'waiting' then ${now}::timestamptz else run_after end`,
      })
      .where("id", "=", id)
      .where("state", "in", ["waiting", "running", "queued"])
      .where("callback_verifier_hash", "=", row.callback_verifier_hash)
      .returning("id")
      .executeTakeFirst();
    if (!updated) throw rejected(404, "raced");
    this.#log.info("job callback accepted", { jobId: id });
  }
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
