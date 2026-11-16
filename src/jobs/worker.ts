import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { JobHandlerDefinition, JobStepResult } from "../connections/provider-types.ts";
import type { ConnectionService } from "../connections/service.ts";
import { type Db, type Tx, transaction } from "../persistence/database.ts";
import type { Clock } from "../platform/clock.ts";
import { ServiceError, type ServiceErrorBody } from "../platform/errors.ts";
import type { Log } from "../platform/log.ts";
import { hashToken, randomToken } from "../platform/secrets.ts";
import { canonicalJson, type JobService, limitsFor, ownerCaller } from "./service.ts";
import type { JobLimits, JobState } from "./types.ts";

export type WorkerOptions = {
  db: Db;
  connections: ConnectionService;
  jobs: JobService;
  clock: Clock;
  log: Log;
  concurrency: number;
  /** How long a claim is held without renewal. */
  leaseMs?: number;
  /** How often a running Job's lease is renewed and its cancel flag read. */
  renewMs?: number;
  /** How often the worker looks for due Jobs when idle. */
  pollMs?: number;
  /** Rows deleted per statement by retention cleanup. */
  batchSize?: number;
};

type Claimed = {
  id: string;
  /** This claim's fencing token, written as the lease owner; every later write is guarded by it. */
  lease: string;
  handler: string;
  definition_id: string | null;
  owner_identity_id: string;
  input: unknown;
  /** The callback body this attempt runs with; meaningful only when `has_resume` is true. */
  resumed: unknown;
  has_resume: boolean;
  attempt: number;
  deadline_at: Date;
  /** The external task an earlier attempt started, if any. */
  external_task_id: string | null;
};

/** What a claim's row says once this worker holds its lock, with the time read after the lock. */
type Locked = {
  now: Date;
  deadline: Date;
  pastDeadline: boolean;
  cancelRequested: boolean;
  /** An earlier attempt of this Job ended in a way the provider may have acted on. */
  earlierEffectsUnknown: boolean;
  hasCallback: boolean;
};

type Ending =
  | { state: "succeeded"; result: string; size: number }
  | { state: "failed"; error: ServiceErrorBody["error"]; remoteEffectsUnknown: boolean }
  | { state: "cancelled"; remoteEffectsUnknown: boolean }
  | { state: "interrupted" };

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RENEW_MS = 10_000;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_BATCH = 500;

class Stop extends Error {
  readonly why: "cancel" | "deadline" | "lease-lost" | "shutdown";
  constructor(why: Stop["why"]) {
    super(`job stopped: ${why}`);
    this.why = why;
  }
}

const INTERRUPTED = {
  code: "interrupted",
  message: "The worker running this Job stopped; the provider may have acted",
};

/** Puts a pending callback back for the next attempt: a newer callback wins over the one in use. */
const REQUEUE_RESUME = { resume: sql<string | null>`coalesce(resume, resuming)`, resuming: null };

/**
 * Runs Jobs from the Jobs table. Each worker process runs up to `concurrency` Jobs, claims with
 * `FOR UPDATE SKIP LOCKED`, renews its leases while running, and writes every state change guarded
 * by the claim's own fencing token, so neither another worker nor an earlier claim of the same Job
 * by this worker can overwrite the current claim.
 *
 * A callback body moves from `resume` to `resuming` when an attempt claims it and stays there until
 * that attempt commits its next state, so a crash at any point loses no callback.
 */
export class JobWorker {
  readonly id = randomUUID();
  readonly #db: Db;
  readonly #connections: ConnectionService;
  readonly #jobs: JobService;
  readonly #clock: Clock;
  readonly #log: Log;
  readonly #concurrency: number;
  readonly #leaseMs: number;
  readonly #renewMs: number;
  readonly #pollMs: number;
  readonly #batch: number;
  readonly #running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  #loop: Promise<void> | undefined;
  #stopping = false;
  #wake: (() => void) | undefined;
  #lastTick = 0;

  constructor(options: WorkerOptions) {
    this.#db = options.db;
    this.#connections = options.connections;
    this.#jobs = options.jobs;
    this.#clock = options.clock;
    this.#log = options.log.child({ worker: this.id });
    this.#concurrency = options.concurrency;
    this.#leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.#renewMs = options.renewMs ?? DEFAULT_RENEW_MS;
    this.#pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.#batch = options.batchSize ?? DEFAULT_BATCH;
  }

  get limits(): JobLimits {
    return this.#jobs.limits;
  }

  /** Jobs this worker is running now. */
  get active(): number {
    return this.#running.size;
  }

  /** When the loop last completed a pass, for the health check. */
  get lastTick(): number {
    return this.#lastTick;
  }

  start(): void {
    if (this.#loop) return;
    this.#stopping = false;
    this.#loop = this.#run();
  }

  /**
   * Stops claiming, gives running Jobs `graceMs` to finish, then aborts the rest. An aborted Job is
   * interrupted, or queued again when its handler declares retries safe.
   */
  async stop(graceMs = 10_000): Promise<void> {
    this.#stopping = true;
    this.#wake?.();
    await this.#loop;
    this.#loop = undefined;
    const pending = [...this.#running.values()];
    const timer = setTimeout(() => {
      for (const run of this.#running.values()) run.controller.abort(new Stop("shutdown"));
    }, graceMs);
    await Promise.all(pending.map((run) => run.done));
    clearTimeout(timer);
  }

  async #run(): Promise<void> {
    while (!this.#stopping) {
      try {
        await this.sweep();
        while (!this.#stopping && this.#running.size < this.#concurrency) {
          const claimed = await this.claim();
          if (!claimed) break;
          this.#launch(claimed);
        }
        this.#lastTick = Date.now();
      } catch (error) {
        this.#log.error("job loop failed", { error });
      }
      if (this.#stopping) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.#pollMs);
        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.#wake = undefined;
    }
  }

  /** Claims one due Job, or nothing. */
  async claim(): Promise<Claimed | undefined> {
    const now = this.#clock.now();
    const lease = new Date(now.getTime() + this.#leaseMs);
    const token = randomUUID();
    const runtime = this.#jobs.limits.runtimeSeconds;
    const result = await sql<Claimed>`
      with picked as (
        select id from jobs
        where state = 'queued' and run_after <= ${now} and not cancel_requested
        order by run_after
        for update skip locked
        limit 1
      )
      update jobs set
        state = 'running',
        lease_owner = ${token},
        lease_expires_at = ${lease},
        attempt = jobs.attempt + 1,
        started_at = coalesce(jobs.started_at, ${now}),
        deadline_at = coalesce(jobs.deadline_at, ${now}::timestamptz + make_interval(secs => ${runtime})),
        resuming = jobs.resume,
        resume = null
      from picked
      where jobs.id = picked.id
      returning jobs.id, jobs.lease_owner as lease, jobs.handler, jobs.definition_id,
        jobs.owner_identity_id, jobs.input, jobs.resuming as resumed,
        (jobs.resuming is not null) as has_resume, jobs.attempt, jobs.deadline_at,
        jobs.external_task_id
    `.execute(this.#db);
    const row = result.rows[0];
    if (!row) return undefined;
    // A handler's own runtime limit can be lower than the installation's.
    const handler = this.#connections.definitions.types.handler(row.handler)?.handler;
    if (handler?.limits?.runtimeSeconds !== undefined) {
      const started = await this.#db
        .selectFrom("jobs")
        .select("started_at")
        .where("id", "=", row.id)
        .executeTakeFirst();
      const own = new Date(
        (started?.started_at ?? now).getTime() +
          limitsFor(this.#jobs.limits, handler).runtimeSeconds * 1000,
      );
      if (own < row.deadline_at) {
        row.deadline_at = own;
        await this.#db
          .updateTable("jobs")
          .set({ deadline_at: own })
          .where("id", "=", row.id)
          .where("lease_owner", "=", token)
          .execute();
      }
    }
    return row;
  }

  #launch(job: Claimed): void {
    const controller = new AbortController();
    const done = this.execute(job, controller)
      .catch((error: unknown) => this.#log.error("job execution failed", { jobId: job.id, error }))
      .finally(() => {
        this.#running.delete(job.lease);
        this.#wake?.();
      });
    this.#running.set(job.lease, { controller, done });
  }

  /** Runs one claimed Job to its next state. Exposed for tests that drive a worker step by step. */
  async execute(job: Claimed, controller = new AbortController()): Promise<void> {
    const log = this.#log.child({ jobId: job.id, handler: job.handler, attempt: job.attempt });
    const registered = this.#connections.definitions.types.handler(job.handler);
    if (!registered || !job.definition_id) {
      await this.#end(job, {
        state: "failed",
        error: { code: "handler-not-found", message: "The Job's handler is not installed" },
        remoteEffectsUnknown: false,
      });
      return;
    }
    const handler = registered.handler;
    const definitionId = job.definition_id;
    const now = this.#clock.now();
    if (job.deadline_at.getTime() <= now.getTime()) {
      await this.#end(job, runtimeExceeded(false));
      return;
    }

    const deadline = setTimeout(
      () => controller.abort(new Stop("deadline")),
      job.deadline_at.getTime() - now.getTime(),
    );
    const renew = setInterval(() => void this.#renew(job, controller), this.#renewMs);
    let step: JobStepResult | undefined;
    let thrown: unknown;
    try {
      const caller = await ownerCaller(this.#db, job.owner_identity_id);
      const definition = await this.#connections.definitions.get(definitionId);
      const fetch = definition
        ? this.#connections.presetContext(definition, controller.signal).fetch
        : ((() =>
            Promise.reject(
              new ServiceError(404, "definition-not-found", "No such definition"),
            )) as typeof globalThis.fetch);
      step = await handler.run({
        input: job.input,
        resume: job.has_resume ? job.resumed : undefined,
        attempt: job.attempt,
        checkout: () => this.#connections.checkout(caller, definitionId, controller.signal),
        fetch,
        progress: (value) => this.#progress(job, value),
        callback: () => this.#issueCallback(job),
        signal: controller.signal,
      });
    } catch (error) {
      thrown = error;
    } finally {
      clearTimeout(deadline);
      clearInterval(renew);
    }

    const stop =
      controller.signal.aborted && controller.signal.reason instanceof Stop
        ? controller.signal.reason
        : undefined;
    if (stop?.why === "lease-lost") {
      log.warn("job lease lost; another worker owns the Job now");
      return;
    }
    if (stop?.why === "shutdown") {
      await this.#interruptOwn(job, handler);
      return;
    }
    // A wait commits under the row lock, which also settles a cancel that arrived meanwhile.
    if (thrown === undefined && step?.kind === "wait" && stop?.why !== "deadline") {
      await this.#wait(job, step.externalTaskId, step.checkAt);
      return;
    }
    // A cancel is settled under the row lock by `#end` and `#fail`, whatever the attempt produced.
    if (stop?.why === "deadline") {
      await this.#end(job, runtimeExceeded(true));
      return;
    }
    if (thrown !== undefined || step === undefined) {
      const error =
        thrown instanceof ServiceError
          ? {
              code: thrown.code,
              message: thrown.message,
              ...(thrown.upstream ? { upstream: thrown.upstream } : {}),
            }
          : { code: "handler-failed", message: "The Job's handler failed" };
      if (!(thrown instanceof ServiceError)) log.warn("job handler threw", { error: thrown });
      // A throw means the handler did not finish its attempt. Whatever the error says about its last
      // request, an earlier operation in the same attempt may have reached the provider, so the outcome
      // is uncertain. A handler reports a settled failure by returning one.
      await this.#fail(job, handler, error, "uncertain");
      return;
    }
    switch (step.kind) {
      case "succeeded": {
        let canonical: { text: string; bytes: number };
        try {
          canonical = canonicalJson(step.result ?? null);
        } catch {
          await this.#end(job, {
            state: "failed",
            error: { code: "result-invalid", message: "The handler's result is not JSON" },
            remoteEffectsUnknown: false,
          });
          return;
        }
        const cap = limitsFor(this.#jobs.limits, handler).resultBytes;
        if (canonical.bytes > cap) {
          await this.#end(job, {
            state: "failed",
            error: { code: "result-too-large", message: `The result is larger than ${cap} bytes` },
            remoteEffectsUnknown: false,
          });
          return;
        }
        await this.#end(job, { state: "succeeded", result: canonical.text, size: canonical.bytes });
        return;
      }
      case "failed":
        await this.#fail(job, handler, { code: step.code, message: step.message }, "settled");
        return;
      case "cancelled":
        await this.#end(job, {
          state: "cancelled",
          remoteEffectsUnknown: step.remoteEffectsUnknown,
        });
        return;
      case "wait":
        await this.#wait(job, step.externalTaskId, step.checkAt);
        return;
    }
  }

  async #renew(job: Claimed, controller: AbortController): Promise<void> {
    try {
      const lease = new Date(this.#clock.now().getTime() + this.#leaseMs);
      const row = await this.#db
        .updateTable("jobs")
        .set({ lease_expires_at: lease })
        .where("id", "=", job.id)
        .where("lease_owner", "=", job.lease)
        .where("state", "=", "running")
        .returning("cancel_requested")
        .executeTakeFirst();
      if (!row) controller.abort(new Stop("lease-lost"));
      else if (row.cancel_requested) controller.abort(new Stop("cancel"));
    } catch (error) {
      // A missed renewal is retried on the next tick; the lease outlives several ticks.
      this.#log.warn("lease renewal failed", { jobId: job.id, error });
    }
  }

  async #progress(job: Claimed, value: unknown): Promise<void> {
    const canonical = canonicalJson(value ?? null);
    await this.#db
      .updateTable("jobs")
      .set({ progress: canonical.text })
      .where("id", "=", job.id)
      .where("lease_owner", "=", job.lease)
      .where("state", "=", "running")
      .execute();
  }

  async #issueCallback(job: Claimed): Promise<{ url: string; verifier: string }> {
    const verifier = randomToken();
    const row = await this.#db
      .updateTable("jobs")
      .set({ callback_verifier_hash: hashToken(verifier) })
      .where("id", "=", job.id)
      .where("lease_owner", "=", job.lease)
      .where("state", "=", "running")
      .returning("id")
      .executeTakeFirst();
    if (!row) throw new Stop("lease-lost");
    return { url: this.#jobs.callbackUrl(job.id), verifier };
  }

  /**
   * Commits this claim's next state. The row is locked first, and only then are the time, the
   * deadline and the claim read, so a commit that waited on the lock is judged by when it actually
   * happens. The claim is valid while its fencing token is the lease owner and the Job is running;
   * only the sweep replaces the token, and it moves the Job out of `running` when it does. Returns
   * undefined when the claim no longer holds the Job.
   */
  async #commit<T>(
    job: Claimed,
    write: (tx: Tx, locked: Locked) => Promise<T>,
  ): Promise<T | undefined> {
    return await transaction(this.#db, async (tx) => {
      const row = await tx
        .selectFrom("jobs")
        .select([
          "deadline_at",
          "cancel_requested",
          "earlier_effects_unknown",
          sql<boolean>`resume is not null`.as("has_callback"),
        ])
        .where("id", "=", job.id)
        .where("lease_owner", "=", job.lease)
        .where("state", "=", "running")
        .forUpdate()
        .executeTakeFirst();
      if (!row) return undefined;
      const now = this.#clock.now();
      const deadline = row.deadline_at ?? job.deadline_at;
      return await write(tx, {
        now,
        deadline,
        pastDeadline: now.getTime() >= deadline.getTime(),
        cancelRequested: row.cancel_requested,
        earlierEffectsUnknown: row.earlier_effects_unknown,
        hasCallback: row.has_callback,
      });
    });
  }

  /**
   * Releases the slot. A callback that already arrived queues the Job again at once. A cancel that
   * arrives during the attempt is never lost: either it is seen under the row lock and the Job ends
   * cancelled, or it waits for this commit and finds the Job waiting. A wait asked for after the
   * deadline ends the Job as `runtime-exceeded`.
   */
  async #wait(job: Claimed, externalTaskId: string, checkAt: Date | undefined): Promise<void> {
    const outcome = await this.#commit(job, async (tx, locked) => {
      if (locked.cancelRequested || locked.pastDeadline) {
        const ending: Ending = locked.cancelRequested
          ? { state: "cancelled", remoteEffectsUnknown: true }
          : runtimeExceeded(true);
        await this.#writeEnding(tx, job, ending, locked, { external_task_id: externalTaskId });
        return ending.state;
      }
      const state = locked.hasCallback ? ("queued" as const) : ("waiting" as const);
      const due = checkAt && checkAt < locked.deadline ? checkAt : locked.deadline;
      await tx
        .updateTable("jobs")
        .set({
          state,
          run_after: state === "queued" ? locked.now : due,
          external_task_id: externalTaskId,
          lease_owner: null,
          lease_expires_at: null,
          resuming: null,
        })
        .where("id", "=", job.id)
        .execute();
      return state;
    });
    this.#log.info("job waiting", { jobId: job.id, state: outcome });
    if (outcome === "cancelled" && job.definition_id)
      await this.#jobs.cancelExternalTask(job.id, {
        handler: job.handler,
        externalTaskId,
        owner: job.owner_identity_id,
        definitionId: job.definition_id,
      });
  }

  /** The columns every final state writes. */
  #finished(now: Date) {
    return {
      lease_owner: null,
      lease_expires_at: null,
      callback_verifier_hash: null,
      resume: null,
      resuming: null,
      finished_at: now,
      record_expires_at: new Date(now.getTime() + this.#jobs.limits.recordRetentionSeconds * 1000),
    };
  }

  /**
   * Ends an attempt that failed. A settled failure is retried when the handler declares retries. An
   * uncertain outcome, where the provider may have acted, is retried only when the handler also
   * declares replay safe; the uncertainty is kept for whatever the Job ends as. Nothing is retried
   * once the deadline has passed, and nothing is retried or failed once a cancel is recorded: the Job
   * ends `cancelled`, reporting unknown remote effects when this attempt's outcome was uncertain.
   */
  async #fail(
    job: Claimed,
    handler: JobHandlerDefinition,
    error: ServiceErrorBody["error"],
    outcome: "settled" | "uncertain",
  ): Promise<void> {
    const uncertain = outcome === "uncertain";
    const retries = handler.retries;
    const result = await this.#commit(job, async (tx, locked) => {
      if (locked.cancelRequested) {
        const ending: Ending = { state: "cancelled", remoteEffectsUnknown: uncertain };
        await this.#writeEnding(tx, job, ending, locked);
        return ending;
      }
      // Past the deadline the failure stands as reported; nothing runs again.
      const replay =
        !locked.pastDeadline &&
        retries !== undefined &&
        job.attempt <= retries.attempts &&
        (!uncertain || handler.retrySafe);
      if (replay) {
        const delay = retries.backoffSeconds * 1000 * 2 ** (job.attempt - 1);
        const runAfter = new Date(locked.now.getTime() + delay);
        if (runAfter < locked.deadline) {
          await tx
            .updateTable("jobs")
            .set({
              state: "queued",
              run_after: runAfter,
              lease_owner: null,
              lease_expires_at: null,
              ...REQUEUE_RESUME,
              error: JSON.stringify(error),
              ...(uncertain ? { earlier_effects_unknown: true } : {}),
            })
            .where("id", "=", job.id)
            .execute();
          return "retry" as const;
        }
      }
      const ending: Ending = { state: "failed", error, remoteEffectsUnknown: uncertain };
      await this.#writeEnding(tx, job, ending, locked);
      return ending;
    });
    if (result === "retry")
      this.#log.info("job will retry", {
        jobId: job.id,
        attempt: job.attempt,
        errorCode: error.code,
      });
    else if (result) this.#logEnding(job, result);
  }

  /**
   * Writes a final state for this claim, deciding under the row lock in this order. A recorded cancel
   * ends the Job `cancelled`: a handler's own cancel keeps what it reports, a failure keeps its
   * uncertainty, and a success reports unknown remote effects because the provider acted and its
   * result is discarded. Otherwise a success that commits at or past the deadline is not published.
   */
  async #end(job: Claimed, ending: Ending): Promise<void> {
    const written = await this.#commit(job, async (tx, locked) => {
      const final: Ending = locked.cancelRequested
        ? {
            state: "cancelled",
            remoteEffectsUnknown:
              ending.state === "cancelled" || ending.state === "failed"
                ? ending.remoteEffectsUnknown
                : true,
          }
        : locked.pastDeadline && ending.state === "succeeded"
          ? runtimeExceeded(true)
          : ending;
      await this.#writeEnding(tx, job, final, locked);
      return final;
    });
    if (written) this.#logEnding(job, written);
  }

  /**
   * Writes a final state under the lock `#commit` holds. A succeeded Job reports no unknown remote
   * effects: an earlier uncertain attempt was replayed only because its handler declares replays
   * safe. Any other ending reports them when this attempt or an earlier one may have left any.
   */
  async #writeEnding(
    tx: Tx,
    job: Claimed,
    ending: Ending,
    locked: Locked,
    extra: { external_task_id?: string } = {},
  ): Promise<void> {
    const own =
      ending.state === "interrupted"
        ? true
        : ending.state === "succeeded"
          ? false
          : ending.remoteEffectsUnknown;
    const resultExpires = new Date(
      locked.now.getTime() + this.#jobs.limits.resultRetentionSeconds * 1000,
    );
    await tx
      .updateTable("jobs")
      .set({
        state: ending.state,
        ...this.#finished(locked.now),
        ...extra,
        error:
          ending.state === "failed"
            ? JSON.stringify(ending.error)
            : ending.state === "interrupted"
              ? JSON.stringify(INTERRUPTED)
              : null,
        remote_effects_unknown:
          ending.state !== "succeeded" && (own || locked.earlierEffectsUnknown),
        ...(ending.state === "succeeded" ? { result_expires_at: resultExpires } : {}),
      })
      .where("id", "=", job.id)
      .execute();
    if (ending.state === "succeeded")
      await tx
        .insertInto("job_results")
        .values({
          job_id: job.id,
          result: ending.result,
          size: ending.size,
          expires_at: resultExpires,
        })
        .execute();
  }

  #logEnding(job: Claimed, ending: Ending): void {
    this.#log.info("job finished", {
      jobId: job.id,
      state: ending.state,
      ...(ending.state === "failed" ? { errorCode: ending.error.code } : {}),
    });
  }

  async #interruptOwn(job: Claimed, handler: JobHandlerDefinition): Promise<void> {
    const written = await this.#commit(job, async (tx, locked) => {
      if (handler.retrySafe && !locked.pastDeadline) {
        await tx
          .updateTable("jobs")
          .set({
            state: "queued",
            run_after: locked.now,
            lease_owner: null,
            lease_expires_at: null,
            ...REQUEUE_RESUME,
            earlier_effects_unknown: true,
          })
          .where("id", "=", job.id)
          .execute();
        return undefined;
      }
      const ending: Ending = { state: "interrupted" };
      await this.#writeEnding(tx, job, ending, locked);
      return ending;
    });
    if (written) this.#logEnding(job, written);
  }

  /**
   * Moves Jobs whose time has come: expired leases become interrupted (or queued again when the
   * handler declares retries safe), and waiting Jobs whose check time arrived run again or, past
   * their deadline, fail.
   */
  async sweep(): Promise<void> {
    const now = this.#clock.now();
    const expired = await this.#db
      .selectFrom("jobs")
      .select(["id", "handler", "cancel_requested", "deadline_at"])
      .where("state", "=", "running")
      .where("lease_expires_at", "<", now)
      .limit(this.#batch)
      .execute();
    for (const job of expired) {
      const handler = this.#connections.definitions.types.handler(job.handler)?.handler;
      const retry = handler?.retrySafe && !job.cancel_requested && (job.deadline_at ?? now) > now;
      const update = this.#db
        .updateTable("jobs")
        .where("id", "=", job.id)
        .where("state", "=", "running")
        .where("lease_expires_at", "<", now);
      if (retry)
        await update
          .set({
            state: "queued",
            run_after: now,
            lease_owner: null,
            lease_expires_at: null,
            ...REQUEUE_RESUME,
            earlier_effects_unknown: true,
          })
          .execute();
      else
        await update
          .set({
            state: job.cancel_requested ? "cancelled" : "interrupted",
            remote_effects_unknown: true,
            ...this.#finished(now),
            ...(job.cancel_requested ? {} : { error: JSON.stringify(INTERRUPTED) }),
          })
          .execute();
      this.#log.warn("job lease expired", { jobId: job.id, retried: Boolean(retry) });
    }

    // A cancel that arrived while an attempt was being queued again ends the Job here; claims skip it.
    const cancelled = await this.#db
      .updateTable("jobs")
      .set({ state: "cancelled", remote_effects_unknown: true, ...this.#finished(now) })
      .where("state", "in", ["queued", "waiting"])
      .where("cancel_requested", "=", true)
      .returning(["id", "handler", "external_task_id", "owner_identity_id", "definition_id"])
      .execute();
    for (const job of cancelled)
      if (job.external_task_id && job.definition_id)
        await this.#jobs.cancelExternalTask(job.id, {
          handler: job.handler,
          externalTaskId: job.external_task_id,
          owner: job.owner_identity_id,
          definitionId: job.definition_id,
        });

    // Waiting Jobs whose check time arrived run again; past the deadline they fail.
    await this.#db
      .updateTable("jobs")
      .set({
        state: "failed",
        remote_effects_unknown: true,
        ...this.#finished(now),
        error: JSON.stringify({
          code: "runtime-exceeded",
          message: "The Job ran past its runtime cap",
        }),
      })
      .where("state", "in", ["waiting", "queued"])
      .where("deadline_at", "<=", now)
      .execute();
    await this.#db
      .updateTable("jobs")
      .set({ state: "queued", run_after: now })
      .where("state", "=", "waiting")
      .where("run_after", "<=", now)
      .execute();
  }

  /** Deletes expired results and finished-Job records in bounded batches. Returns rows deleted. */
  async cleanup(): Promise<{ results: number; records: number }> {
    const now = this.#clock.now();
    const results = await this.#db
      .deleteFrom("job_results")
      .where("job_id", "in", (eb) =>
        eb
          .selectFrom("job_results")
          .select("job_id")
          .where("expires_at", "<=", now)
          .limit(this.#batch),
      )
      .executeTakeFirst();
    const records = await this.#db
      .deleteFrom("jobs")
      .where("id", "in", (eb) =>
        eb
          .selectFrom("jobs")
          .select("id")
          .where("record_expires_at", "<=", now)
          .where("state", "in", ["succeeded", "failed", "cancelled", "interrupted"])
          .limit(this.#batch),
      )
      .executeTakeFirst();
    return { results: Number(results.numDeletedRows), records: Number(records.numDeletedRows) };
  }
}

function runtimeExceeded(remoteEffectsUnknown: boolean): Ending {
  return {
    state: "failed",
    error: { code: "runtime-exceeded", message: "The Job ran past its runtime cap" },
    remoteEffectsUnknown,
  };
}
