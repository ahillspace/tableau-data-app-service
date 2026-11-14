import { randomUUID } from "node:crypto";
import type { ClaimRef } from "../core-ports.js";
import { ServiceError } from "../http/errors.js";
import { ExecutionLifetime } from "../runtime/lifetime.js";
import type { JobRow } from "./database.js";
import type { PreparedPayload } from "./payloads.js";
import { JobsService } from "./service.js";
import type { ExecutionOutcome, JobContext, ObservationOutcome } from "./types.js";

export type WorkerOptions = {
  executionSlots: number;
  observationSlots: number;
  leaseMs: number;
  heartbeatMs: number;
  scanMs: number;
  cleanupMs: number;
  batchSize: number;
  requestTermination(reason: string): void;
};
export class JobsWorker {
  readonly incarnation = randomUUID();
  readonly #active = new Map<string, ExecutionLifetime>();
  readonly #tasks = new Set<Promise<void>>();
  #preferCleanup = false;
  #executing = 0;
  #observing = 0;
  #draining = false;
  #running = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #tick: Promise<void> | undefined;
  #ready = true;
  #scanning: Promise<void> | undefined;
  #wakeAgain = false;
  constructor(
    readonly jobs: JobsService,
    readonly options: WorkerOptions,
  ) {
    for (const [key, value] of Object.entries(options))
      if (key !== "requestTermination" && (!Number.isSafeInteger(value) || (value as number) <= 0))
        throw new Error("Invalid worker bound");
    if (
      options.heartbeatMs * 3 >= options.leaseMs ||
      options.scanMs >= options.leaseMs ||
      options.cleanupMs >= options.leaseMs
    )
      throw new Error("Invalid worker timing relationships");
  }
  get readiness(): boolean {
    return this.#ready && !this.#draining && this.jobs.options.payloads.ready;
  }
  get activeExecutions(): number {
    return this.#executing;
  }
  async start(): Promise<void> {
    await this.jobs.assertCompatibility();
    if (this.#running) return;
    this.#running = true;
    this.wake();
  }
  wake(): void {
    if (!this.#running || this.#draining) return;
    if (this.#tick) {
      this.#wakeAgain = true;
      return;
    }
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#tick = this.scan()
        .catch(() => {
          this.#ready = false;
        })
        .finally(async () => {
          let delay = this.options.scanMs;
          if (this.#running && !this.#draining) {
            try {
              const due = await this.jobs.nextDue();
              if (due && due.getTime() > Date.now())
                delay = Math.min(delay, Math.max(1, due.getTime() - Date.now()));
            } catch {
              this.#ready = false;
            }
          }
          this.#tick = undefined;
          if (!this.#running || this.#draining) return;
          if (this.#wakeAgain) {
            this.#wakeAgain = false;
            this.wake();
            return;
          }
          this.#timer = setTimeout(() => {
            this.#timer = undefined;
            this.wake();
          }, delay);
        });
    }, 0);
  }
  scan(): Promise<void> {
    // Local scan serialization protects measured process capacity, while Postgres
    // claims remain the shared authority across independent worker incarnations.
    if (this.#scanning) return this.#scanning;
    this.#scanning = this.runScan().finally(() => {
      this.#scanning = undefined;
    });
    return this.#scanning;
  }
  private async runScan(): Promise<void> {
    if (!(await this.jobs.required())) {
      this.#running = false;
      return;
    }
    await this.jobs.controls(this.options.batchSize, this.options.cleanupMs);
    await this.jobs.retain(this.options.batchSize);
    if (this.#draining || !this.jobs.options.payloads.ready) {
      this.#ready = false;
      return;
    }
    // Independent read-only I/O capacity gives external observations a fair turn.
    this.#preferCleanup = !this.#preferCleanup;
    const observations = await this.jobs.candidates(
      "observe",
      this.#preferCleanup
        ? 0
        : Math.min(this.options.batchSize, this.options.observationSlots - this.#observing),
    );
    for (const hint of observations) {
      if (this.#draining || this.#observing >= this.options.observationSlots) break;
      const acquired = await this.claimReady(hint, "observe");
      if (acquired) {
        const { row, release } = acquired;
        this.#observing++;
        this.track(this.attempt(row), () => {
          release();
          this.#observing--;
          this.wake();
        });
      }
    }
    const cleanups = await this.jobs.cleanupCandidates(
      Math.min(this.options.batchSize, this.options.observationSlots - this.#observing),
    );
    for (const hint of cleanups) {
      if (this.#draining || this.#observing >= this.options.observationSlots) break;
      const acquired = await this.claimReady(hint, "remote-cancel");
      if (acquired) {
        const { row, release } = acquired;
        this.#observing++;
        this.track(this.remoteCancel(row), () => {
          release();
          this.#observing--;
          this.wake();
        });
      }
    }
    if (this.#executing < this.options.executionSlots) {
      const starts = await this.jobs.candidates(
        "execute",
        Math.min(this.options.batchSize, this.options.executionSlots - this.#executing),
      );
      for (const hint of starts) {
        if (this.#draining || this.#executing >= this.options.executionSlots) break;
        const acquired = await this.claimReady(hint, "execute");
        if (acquired) {
          const { row, release } = acquired;
          this.#executing++;
          this.track(this.attempt(row), () => {
            release();
            this.#executing--;
            this.wake();
          });
        }
      }
    }
    this.#ready = true;
  }
  private async claimReady(
    hint: JobRow,
    kind: "execute" | "observe" | "remote-cancel",
  ): Promise<{ row: JobRow; release(): void } | null> {
    const metadata = await this.jobs.control
      .selectFrom("job_payloads")
      .select("bytes")
      .where("job_id", "=", hint.id)
      .where("kind", "=", kind === "execute" ? "input" : "task")
      .executeTakeFirst();
    if (!metadata) return null;
    let release: () => void;
    try {
      release = this.jobs.options.payloads.reserve(metadata.bytes * 8);
    } catch (error) {
      if (error instanceof ServiceError && error.code === "payload-capacity-unavailable")
        return null;
      throw error;
    }
    try {
      const row =
        kind === "remote-cancel"
          ? await this.jobs.claimCleanup(hint, this.incarnation, this.options.leaseMs)
          : await this.jobs.claim(hint, kind, this.incarnation, this.options.leaseMs);
      if (!row) {
        release();
        return null;
      }
      return { row, release };
    } catch (error) {
      release();
      throw error;
    }
  }
  track(task: Promise<void>, release: () => void): void {
    const tracked = task
      .catch(() => {
        this.#ready = false;
      })
      .finally(() => {
        this.#tasks.delete(tracked);
        release();
      });
    this.#tasks.add(tracked);
  }
  lifetime(id: string): ExecutionLifetime {
    const life = new ExecutionLifetime({
      cleanupMs: this.options.cleanupMs,
      requestTermination: (reason) => {
        this.#draining = true;
        this.#running = false;
        if (this.#timer) clearTimeout(this.#timer);
        for (const active of this.#active.values()) active.abort(new Error("Worker draining"));
        this.options.requestTermination(reason);
      },
    });
    this.#active.set(id, life);
    return life;
  }
  async attempt(row: JobRow): Promise<void> {
    const declaration = this.jobs.declaration(row)!;
    const claim: ClaimRef = { token: row.claim_token!, incarnation: row.incarnation! };
    const life = this.lifetime(row.id);
    let heartbeatBusy = false;
    const beat = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void this.jobs
        .heartbeat(row.id, claim, this.options.leaseMs)
        .then((live) => {
          if (!live) life.abort(new Error("Job claim fenced"));
        })
        .catch(() => {
          this.#ready = false;
          life.abort(new Error("Job authority unavailable"));
        })
        .finally(() => {
          heartbeatBusy = false;
        });
    }, this.options.heartbeatMs);
    const deadline = setTimeout(
      () => life.abort(new Error("Job deadline")),
      Math.max(1, row.deadline!.getTime() - Date.now()),
    );
    try {
      const prepared: { result?: PreparedPayload; task?: PreparedPayload } = {};
      const outcome = await life.run(async () => {
        const scope = await this.jobs.options.core.connections.openScope(
          { source: "job", jobId: row.id, claim },
          row.provider_registration_id,
          row.connection_id ?? undefined,
          life.signal,
        );
        life.own((reason) => scope.dispose(reason));
        const context: JobContext = {
          ...scope.context,
          jobId: row.id,
          deadline: row.deadline!.toISOString(),
          reportProgress: (value) => this.jobs.progress(row, claim, value),
          ...(row.callback_correlation
            ? {
                callbackBinding: {
                  correlation: row.callback_correlation,
                  callbackUrl: `${this.jobs.options.callbackOrigin}/v1/providers/${row.provider_registration_id}/tasks/${declaration.external!.callback!.route}`,
                },
              }
            : {}),
        };
        let outcome: ExecutionOutcome | ObservationOutcome;
        try {
          life.signal.throwIfAborted();
          outcome =
            row.claim_kind === "execute"
              ? await declaration.handler(await this.jobs.payload(row, "input"), context)
              : await declaration.external!.observe!(await this.jobs.task(row), context);
        } catch {
          outcome = {
            kind: "failed",
            error: {
              code: "execution-unknown",
              message:
                "Execution did not return a settled outcome; external effects may be unknown",
            },
          };
        }
        try {
          if (outcome.kind === "waiting")
            prepared.task = await this.jobs.prepareTask(row, outcome.task);
          if (
            outcome.kind === "complete" ||
            outcome.kind === "succeeded" ||
            (outcome.kind === "failed" && outcome.result !== undefined)
          )
            prepared.result = await this.jobs.prepareResult(row, outcome.result);
          if (outcome.kind === "pending" && outcome.progress !== undefined)
            await this.jobs.progress(row, claim, outcome.progress);
        } catch {
          outcome = {
            kind: "failed",
            error: {
              code: "invalid-outcome",
              message:
                "Returned outcome could not be safely stored; external effects may be unknown",
            },
          };
          delete prepared.result;
          delete prepared.task;
        }
        return outcome;
      });
      // The previous attempt has actually disposed before any retry can be scheduled.
      await this.jobs.publish(row, claim, outcome, prepared, this.options.cleanupMs);
    } finally {
      clearInterval(beat);
      clearTimeout(deadline);
      this.#active.delete(row.id);
    }
  }
  async remoteCancel(row: JobRow): Promise<void> {
    const claim = { token: row.cleanup_token!, incarnation: row.cleanup_incarnation! };
    const life = this.lifetime(`cancel:${row.id}`);
    const deadline = setTimeout(
      () => life.abort(),
      Math.max(1, row.cleanup_deadline!.getTime() - Date.now()),
    );
    try {
      // The irreversible issued marker commits before any provider call, including checkout.
      if (!(await this.jobs.issueCancel(row, claim))) return;
      let status: "confirmed" | "unconfirmed" | "unavailable" = "unconfirmed";
      await life.run(async () => {
        try {
          const scope = await this.jobs.options.core.connections.openScope(
            { source: "remote-cancel", jobId: row.id, claim },
            row.provider_registration_id,
            row.connection_id ?? undefined,
            life.signal,
          );
          life.own((reason) => scope.dispose(reason));
          status = await this.jobs.declaration(row)!.external!.cancel!(await this.jobs.task(row), {
            ...scope.context,
            deadline: row.cleanup_deadline!.toISOString(),
          });
        } catch {
          status = "unconfirmed";
        }
      });
      await this.jobs.cancelEvidence(row, claim, status);
    } finally {
      clearTimeout(deadline);
      this.#active.delete(`cancel:${row.id}`);
    }
  }
  async close(): Promise<void> {
    this.#running = false;
    this.#draining = true;
    if (this.#timer) clearTimeout(this.#timer);
    for (const active of this.#active.values()) active.abort(new Error("Worker shutting down"));
    await this.#tick;
    await this.#scanning;
    await Promise.allSettled([...this.#tasks]);
    // Core's host grace supervises active lifetimes, which retain their slots until settled/exit.
  }
}
