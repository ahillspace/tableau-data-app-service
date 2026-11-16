import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type {
  JobHandlerDefinition,
  JobRunContext,
  JobStepResult,
  ProviderType,
} from "../src/connections/provider-types.ts";
import { listSites } from "../src/identity/directory.ts";
import type { Principal } from "../src/identity/types.ts";
import { JobService } from "../src/jobs/service.ts";
import type { JobLimits } from "../src/jobs/types.ts";
import { JobWorker } from "../src/jobs/worker.ts";
import type { Db } from "../src/persistence/database.ts";
import { ServiceError } from "../src/platform/errors.ts";
import { Log } from "../src/platform/log.ts";
import { hashToken } from "../src/platform/secrets.ts";
import { type ConnectionsHarness, connectionsHarness } from "./support/connections.ts";
import { freshDatabase, testKeys } from "./support/db.ts";
import {
  appSignIn,
  type IdentityHarness,
  identityHarness,
  tableauSignIn,
} from "./support/identity.ts";
import { TableauStandIn, type TableauUser } from "./support/tableau.ts";

const alice: TableauUser = {
  siteId: "site-a",
  siteContentUrl: "alpha",
  userId: "user-a",
  userName: "alice@example.com",
};
const bob: TableauUser = {
  siteId: "site-a",
  siteContentUrl: "alpha",
  userId: "user-b",
  userName: "bob@example.com",
};

type Behavior = (ctx: JobRunContext) => Promise<JobStepResult>;

/** Handlers whose behavior each test sets. */
const behaviors = new Map<string, Behavior>();
const cancels: string[] = [];
function handler(name: string, extra: Partial<JobHandlerDefinition> = {}): JobHandlerDefinition {
  return {
    name,
    retrySafe: false,
    run: (ctx) =>
      (behaviors.get(name) ?? (async () => ({ kind: "succeeded", result: ctx.input })))(ctx),
    ...extra,
  };
}

const tasks: ProviderType = {
  name: "tasks",
  oauth: "none",
  staticCredential: true,
  credentialless: false,
  jobHandlers: [
    handler("echo"),
    handler("safe", { retrySafe: true }),
    handler("flaky", { retries: { attempts: 2, backoffSeconds: 0 } }),
    handler("small", { limits: { inputBytes: 64, resultBytes: 64, runtimeSeconds: 60 } }),
    handler("remote", {
      cancel: async (ctx) => {
        cancels.push(ctx.externalTaskId);
      },
    }),
  ],
};

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ServiceError, String(error));
    return error.code;
  }
  assert.fail("expected a ServiceError");
}

const LIMITS: JobLimits = {
  inputBytes: 4096,
  resultBytes: 4096,
  runtimeSeconds: 3600,
  resultRetentionSeconds: 7 * 86400,
  recordRetentionSeconds: 30 * 86400,
};

describe("jobs", () => {
  let tableau: TableauStandIn;
  let db: Db;
  let closeDb: (() => Promise<void>) | undefined;
  let h: IdentityHarness;
  let c: ConnectionsHarness;
  let jobs: JobService;
  let lines: string[];
  let a: Principal;
  let b: Principal;

  const worker = (concurrency = 1) =>
    new JobWorker({
      db,
      connections: c.connections,
      jobs,
      clock: h.clock,
      log: new Log((line) => lines.push(line)),
      concurrency,
      leaseMs: 30_000,
      renewMs: 50,
      pollMs: 20,
    });

  /** Claims and runs the next due Job on a worker. */
  async function step(w: JobWorker): Promise<string | undefined> {
    const claimed = await w.claim();
    if (!claimed) return undefined;
    await w.execute(claimed);
    return claimed.id;
  }

  const submit = (p: Principal, handlerName: string, input: unknown, key: string) =>
    jobs.submit(p, { handler: handlerName, definitionId: "work", input, submissionKey: key });

  before(async () => {
    tableau = await new TableauStandIn().start();
  });
  after(async () => {
    await h.close();
    await closeDb?.();
    await tableau.close();
  });
  beforeEach(async () => {
    behaviors.clear();
    cancels.length = 0;
    if (closeDb) {
      await h.close();
      await closeDb();
    }
    ({ db, close: closeDb } = await freshDatabase());
    h = await identityHarness(db, tableau);
    c = connectionsHarness(db, {
      keys: testKeys(),
      outbound: h.outbound,
      clock: h.clock,
      presets: [tasks],
    });
    lines = [];
    jobs = new JobService({
      db,
      connections: c.connections,
      limits: LIMITS,
      publicOrigin: "https://service.test",
      clock: h.clock,
      log: new Log((line) => lines.push(line)),
    });
    const siteId = ((await listSites(db))[0] as { id: string }).id;
    await c.definitions.create("test", {
      id: "work",
      displayName: "Work",
      type: "tasks",
      ownership: "personal",
      apiHosts: ["https://work.example"],
      audience: [siteId],
    });
    a = (await appSignIn(h, (await tableauSignIn(h, tableau, alice)).cookie)).principal;
    b = (await appSignIn(h, (await tableauSignIn(h, tableau, bob)).cookie)).principal;
    await c.connections.setPersonalCredential(a, "work", "alice-key");
  });

  test("V20 admission is idempotent per submission key and committed before it answers", async () => {
    assert.equal(await code(submit(b, "echo", 1, "k1")), "not-connected");
    assert.equal(await code(submit(a, "missing", 1, "k1")), "handler-not-found");

    const first = await submit(a, "echo", { b: 1, a: [1, 2] }, "k1");
    assert.equal(first.created, true);
    assert.equal(first.job.state, "queued");
    // Committed: a separate pool sees it at once.
    const { db: other, close } = await (async () => {
      const { openDatabase } = await import("../src/persistence/database.ts");
      const { caCert } = await import("./support/db.ts");
      const url = new URL(process.env.TDAS_TEST_PG as string);
      const name = (
        await db
          .selectNoFrom((eb) => eb.fn<string>("current_database", []).as("n"))
          .executeTakeFirstOrThrow()
      ).n;
      url.pathname = `/${name}`;
      const opened = openDatabase({
        url: url.href,
        caCert: caCert(),
        applicationName: "tdas-other",
      });
      return { db: opened.db, close: () => opened.db.destroy() };
    })();
    assert.ok(
      await other.selectFrom("jobs").select("id").where("id", "=", first.job.id).executeTakeFirst(),
    );
    await close();

    // Same key and the same input in another key order is the same Job.
    const again = await submit(a, "echo", { a: [1, 2], b: 1 }, "k1");
    assert.equal(again.created, false);
    assert.equal(again.job.id, first.job.id);
    assert.equal(
      await code(submit(a, "echo", { a: [2, 1], b: 1 }, "k1")),
      "submission-key-conflict",
    );

    // Concurrent submissions with one key admit one Job.
    const raced = await Promise.all(Array.from({ length: 8 }, () => submit(a, "echo", "x", "k2")));
    assert.equal(new Set(raced.map((r) => r.job.id)).size, 1);
    assert.equal(raced.filter((r) => r.created).length, 1);

    // Another owner's key space is separate, and another owner cannot read the Job.
    await c.connections.setPersonalCredential(b, "work", "bob-key");
    const bobs = await submit(b, "echo", "x", "k2");
    assert.notEqual(bobs.job.id, raced[0]?.job.id);
    assert.equal(await code(jobs.get(b, first.job.id)), "job-not-found");
    assert.deepEqual((await jobs.listOwn(a)).map((j) => j.submissionKey).sort(), ["k1", "k2"]);

    // With the database gone, admission fails instead of answering accepted.
    await db.destroy();
    await assert.rejects(submit(a, "echo", "y", "k3"));
    closeDb = undefined;
    ({ db, close: closeDb } = await freshDatabase());
  });

  test("a Job runs with the owner's current connection, reports progress and keeps its result after disconnect", async () => {
    behaviors.set("echo", async (ctx) => {
      const lease = await ctx.checkout();
      const request = { target: "/x", headers: [] as [string, string][] };
      lease.apply(request);
      await ctx.progress({ done: 1 });
      return { kind: "succeeded", result: { input: ctx.input, auth: request.headers[0]?.[1] } };
    });
    const { job } = await submit(a, "echo", "hello", "run-1");
    const w = worker();
    assert.equal(await step(w), job.id);
    const done = await jobs.get(a, job.id);
    assert.equal(done.state, "succeeded");
    assert.deepEqual(done.progress, { done: 1 });
    assert.equal(done.result?.available, true);
    assert.deepEqual(await jobs.result(a, job.id), { input: "hello", auth: "Bearer alice-key" });
    await c.connections.disconnectOwn(a, "work");
    assert.deepEqual(await jobs.result(a, job.id), { input: "hello", auth: "Bearer alice-key" });

    // A queued Job whose owner disconnected fails with not-connected when it runs.
    await c.connections.setPersonalCredential(a, "work", "alice-key");
    const second = await submit(a, "echo", "again", "run-2");
    await c.connections.disconnectOwn(a, "work");
    await step(w);
    const failed = await jobs.get(a, second.job.id);
    assert.equal(failed.state, "failed");
    assert.equal(failed.error?.code, "not-connected");
    assert.equal(await code(jobs.result(a, second.job.id)), "job-has-no-result");
  });

  test("V21 a crashed worker's Job is interrupted, and replayed only when the handler declares it safe", async () => {
    const unsafe = await submit(a, "echo", 1, "crash-1");
    const safe = await submit(a, "safe", 1, "crash-2");
    const crashed = worker();
    // The worker claims both and dies before finishing either.
    assert.ok(await crashed.claim());
    assert.ok(await crashed.claim());

    const survivor = worker();
    await survivor.sweep();
    assert.equal((await jobs.get(a, unsafe.job.id)).state, "running");
    h.clock.offsetMs += 31_000;
    await survivor.sweep();
    const interrupted = await jobs.get(a, unsafe.job.id);
    assert.equal(interrupted.state, "interrupted");
    assert.equal(interrupted.remoteEffectsUnknown, true);
    assert.equal(interrupted.error?.code, "interrupted");
    assert.equal((await jobs.get(a, safe.job.id)).state, "queued");
    assert.equal(await step(survivor), safe.job.id);
    const replayed = await jobs.get(a, safe.job.id);
    assert.equal(replayed.state, "succeeded");
    assert.equal(replayed.attempt, 2);
    // Nothing runs the unsafe Job again.
    assert.equal(await step(survivor), undefined);

    // The crashed worker's late ending cannot overwrite what the survivor decided.
    const stale = await db
      .selectFrom("jobs")
      .select("state")
      .where("id", "=", unsafe.job.id)
      .executeTakeFirstOrThrow();
    assert.equal(stale.state, "interrupted");
  });

  test("settled failures retry only when the handler opts in", async () => {
    let calls = 0;
    behaviors.set("flaky", async () => {
      calls++;
      return calls < 3
        ? { kind: "failed", code: "busy", message: "try later" }
        : { kind: "succeeded", result: calls };
    });
    behaviors.set("echo", async () => ({ kind: "failed", code: "busy", message: "no" }));
    const flaky = await submit(a, "flaky", 1, "f1");
    const plain = await submit(a, "echo", 1, "f2");
    const w = worker();
    while (await step(w)) {}
    assert.equal((await jobs.get(a, flaky.job.id)).state, "succeeded");
    assert.equal(calls, 3);
    const failed = await jobs.get(a, plain.job.id);
    assert.equal(failed.state, "failed");
    assert.equal(failed.attempt, 1);
  });

  test("V22 a waiting Job releases its slot and resumes once on a verified callback", async () => {
    let issued: { url: string; verifier: string } | undefined;
    behaviors.set("remote", async (ctx) => {
      if (ctx.resume !== undefined)
        return { kind: "succeeded", result: { resumedWith: ctx.resume } };
      issued = await ctx.callback();
      return { kind: "wait", externalTaskId: "task-9" };
    });
    const waiting = await submit(a, "remote", 1, "w1");
    const other = await submit(a, "echo", 2, "w2");
    const w = worker(1);
    w.start();
    try {
      for (let i = 0; i < 100 && (await jobs.get(a, other.job.id)).state !== "succeeded"; i++)
        await new Promise((r) => setTimeout(r, 20));
      // The waiting Job gave up its only slot, so the second Job ran.
      assert.equal((await jobs.get(a, other.job.id)).state, "succeeded");
      const parked = await jobs.get(a, waiting.job.id);
      assert.equal(parked.state, "waiting");
      assert.equal(parked.externalTaskId, "task-9");
      assert.equal(w.active, 0);
      assert.ok(issued);
      assert.equal(issued.url, `https://service.test/v1/jobs/callbacks/${waiting.job.id}`);

      assert.equal(
        await code(jobs.callback(waiting.job.id, "wrong", { ok: true })),
        "job-callback-invalid",
      );
      assert.equal(
        await code(jobs.callback(waiting.job.id, undefined, { ok: true })),
        "job-callback-invalid",
      );
      await jobs.callback(waiting.job.id, issued.verifier, { ok: true });
      // The verifier is single use.
      assert.equal(
        await code(jobs.callback(waiting.job.id, issued.verifier, { ok: true })),
        "job-callback-invalid",
      );
      for (let i = 0; i < 100 && (await jobs.get(a, waiting.job.id)).state !== "succeeded"; i++)
        await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(await jobs.result(a, waiting.job.id), { resumedWith: { ok: true } });
      assert.equal(
        await code(jobs.callback(waiting.job.id, issued.verifier, {})),
        "job-callback-invalid",
      );
      assert.ok(lines.some((l) => l.includes("job callback rejected")));
      assert.ok(!lines.some((l) => l.includes(issued?.verifier as string)));
    } finally {
      await w.stop();
    }
  });

  test("a callback that arrives before the wait is recorded still resumes the Job", async () => {
    behaviors.set("remote", async (ctx) => {
      if (ctx.resume !== undefined) return { kind: "succeeded", result: ctx.resume };
      const { verifier } = await ctx.callback();
      await jobs.callback(
        (await db.selectFrom("jobs").select("id").executeTakeFirstOrThrow()).id,
        verifier,
        "early",
      );
      return { kind: "wait", externalTaskId: "t" };
    });
    const { job } = await submit(a, "remote", 1, "early");
    const w = worker();
    await step(w);
    assert.equal((await jobs.get(a, job.id)).state, "queued");
    await step(w);
    assert.equal(await jobs.result(a, job.id), "early");
  });

  test("a callback body survives a worker crash after the claim, and a null body still resumes", async () => {
    let seen: unknown[] = [];
    behaviors.set("safe", async (ctx) => {
      if (ctx.resume !== undefined) {
        seen.push(ctx.resume);
        return { kind: "succeeded", result: { got: ctx.resume } };
      }
      await ctx.callback();
      return { kind: "wait", externalTaskId: "t" };
    });
    const { job } = await submit(a, "safe", 1, "resume-crash");
    const w = worker();
    await step(w);
    assert.equal((await jobs.get(a, job.id)).state, "waiting");
    // Issue a verifier the test can use, as the handler's external task would.
    const verifier = "v-crash";
    await db
      .updateTable("jobs")
      .set({ callback_verifier_hash: hashToken(verifier) })
      .where("id", "=", job.id)
      .execute();
    await jobs.callback(job.id, verifier, null);

    // The worker claims the resumed attempt and dies before it commits anything.
    const crashed = worker();
    assert.ok(await crashed.claim());
    h.clock.offsetMs += 31_000;
    await w.sweep();
    assert.equal((await jobs.get(a, job.id)).state, "queued");
    seen = [];
    await step(w);
    assert.deepEqual(seen, [null]);
    assert.deepEqual(await jobs.result(a, job.id), { got: null });
  });

  test("a stale claim cannot write over a newer claim of the same Job by the same worker", async () => {
    let runs = 0;
    behaviors.set("safe", async () => {
      runs++;
      return { kind: "succeeded", result: runs };
    });
    const { job } = await submit(a, "safe", 1, "fence");
    const w = worker();
    const first = await w.claim();
    assert.ok(first);
    h.clock.offsetMs += 31_000;
    await w.sweep();
    const second = await w.claim();
    assert.ok(second);
    assert.notEqual(first.lease, second.lease);
    // The first claim finishes late; its ending is fenced out.
    await w.execute(first);
    assert.equal((await jobs.get(a, job.id)).state, "running");
    await w.execute(second);
    assert.equal(await jobs.result(a, job.id), 2);
  });

  test("a cancel that arrives while a running Job asks to wait ends it and stops the external task", async () => {
    behaviors.set("remote", async () => {
      await jobs.cancelOwn(
        a,
        (await db.selectFrom("jobs").select("id").executeTakeFirstOrThrow()).id,
      );
      return { kind: "wait", externalTaskId: "racing-task" };
    });
    const { job } = await submit(a, "remote", 1, "race");
    const w = worker();
    await step(w);
    const ended = await jobs.get(a, job.id);
    assert.equal(ended.state, "cancelled");
    assert.deepEqual(cancels, ["racing-task"]);
    assert.equal(ended.remoteEffectsUnknown, false);

    // A waiting Job left with a cancel request is ended by the sweep, never claimed.
    behaviors.set("remote", async () => ({ kind: "wait", externalTaskId: "left" }));
    const left = await submit(a, "remote", 2, "race-2");
    await step(w);
    await db
      .updateTable("jobs")
      .set({ cancel_requested: true, run_after: new Date(0) })
      .where("id", "=", left.job.id)
      .execute();
    await w.sweep();
    assert.equal((await jobs.get(a, left.job.id)).state, "cancelled");
    assert.deepEqual(cancels, ["racing-task", "left"]);
    assert.equal(await step(w), undefined);
  });

  test("waiting Jobs check back at their own time, and cancel asks the handler to stop the task", async () => {
    let checks = 0;
    behaviors.set("remote", async () => {
      checks++;
      return {
        kind: "wait",
        externalTaskId: `t${checks}`,
        checkAt: new Date(h.clock.now().getTime() + 60_000),
      };
    });
    const { job } = await submit(a, "remote", 1, "poll");
    const w = worker();
    await step(w);
    assert.equal(await step(w), undefined);
    h.clock.offsetMs += 61_000;
    await w.sweep();
    assert.equal(await step(w), job.id);
    assert.equal(checks, 2);
    const cancelled = await jobs.cancelOwn(a, job.id);
    assert.equal(cancelled.state, "cancelled");
    assert.deepEqual(cancels, ["t2"]);
    assert.equal((await jobs.get(a, job.id)).remoteEffectsUnknown, false);
  });

  test("cancelling a Job queued to check its external task stops that task", async () => {
    behaviors.set("remote", async () => ({
      kind: "wait",
      externalTaskId: "checked",
      checkAt: new Date(h.clock.now().getTime() + 60_000),
    }));
    const { job } = await submit(a, "remote", 1, "queued-check");
    const w = worker();
    await step(w);
    h.clock.offsetMs += 61_000;
    await w.sweep();
    assert.equal((await jobs.get(a, job.id)).state, "queued");
    const cancelled = await jobs.cancelOwn(a, job.id);
    assert.equal(cancelled.state, "cancelled");
    assert.deepEqual(cancels, ["checked"]);
    assert.equal(cancelled.remoteEffectsUnknown, false);
  });

  test("cancelling a queued Job ends it, and a running Job ends cancelled when its handler returns", async () => {
    const queued = await submit(a, "echo", 1, "c1");
    assert.equal((await jobs.cancelOwn(a, queued.job.id)).state, "cancelled");
    assert.equal(await code(jobs.cancelOwn(b, queued.job.id)), "job-not-found");

    let started!: () => void;
    const running = new Promise<void>((r) => {
      started = r;
    });
    behaviors.set("echo", async (ctx) => {
      started();
      await new Promise<void>((resolve) =>
        ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { kind: "cancelled", remoteEffectsUnknown: false };
    });
    const { job } = await submit(a, "echo", 2, "c2");
    const w = worker();
    w.start();
    try {
      await running;
      assert.equal((await jobs.cancelOwn(a, job.id)).state, "running");
      for (let i = 0; i < 100 && (await jobs.get(a, job.id)).state === "running"; i++)
        await new Promise((r) => setTimeout(r, 20));
      const ended = await jobs.get(a, job.id);
      assert.equal(ended.state, "cancelled");
      assert.equal(ended.remoteEffectsUnknown, false);
    } finally {
      await w.stop();
    }
  });

  test("V23 caps and retention windows are enforced", async () => {
    assert.equal(await code(submit(a, "small", "x".repeat(80), "cap-1")), "input-too-large");
    assert.equal(await code(submit(a, "echo", "x".repeat(5000), "cap-2")), "input-too-large");
    behaviors.set("small", async () => ({ kind: "succeeded", result: "y".repeat(100) }));
    const big = await submit(a, "small", "ok", "cap-3");
    const w = worker();
    await step(w);
    const tooLarge = await jobs.get(a, big.job.id);
    assert.equal(tooLarge.state, "failed");
    assert.equal(tooLarge.error?.code, "result-too-large");

    // The runtime cap runs from first start and includes waits.
    behaviors.set("small", async (ctx) =>
      ctx.resume === undefined
        ? { kind: "wait", externalTaskId: "slow" }
        : { kind: "succeeded", result: 1 },
    );
    const slow = await submit(a, "small", "ok", "cap-4");
    await step(w);
    h.clock.offsetMs += 61_000;
    await w.sweep();
    const exceeded = await jobs.get(a, slow.job.id);
    assert.equal(exceeded.state, "failed");
    assert.equal(exceeded.error?.code, "runtime-exceeded");

    // A running handler is aborted at its deadline.
    behaviors.set("small", async (ctx) => {
      await new Promise<void>((resolve) =>
        ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { kind: "succeeded", result: "late" };
    });
    const hung = await submit(a, "small", "ok", "cap-5");
    const claimed = await w.claim();
    assert.ok(claimed);
    claimed.deadline_at = new Date(h.clock.now().getTime() + 50);
    await w.execute(claimed);
    assert.equal((await jobs.get(a, hung.job.id)).error?.code, "runtime-exceeded");

    // Results expire after their window; the record stays and still answers its submission key.
    const kept = await submit(a, "echo", "keep", "ret-1");
    await step(w);
    assert.equal(await jobs.result(a, kept.job.id), "keep");
    h.clock.offsetMs += 7 * 86400_000 + 1000;
    assert.equal(await code(jobs.result(a, kept.job.id)), "result-expired");
    assert.equal((await jobs.get(a, kept.job.id)).result?.available, false);
    const cleaned = await w.cleanup();
    assert.ok(cleaned.results >= 1);
    assert.equal(cleaned.records, 0);
    const repeat = await submit(a, "echo", "keep", "ret-1");
    assert.equal(repeat.job.id, kept.job.id);
    assert.equal(repeat.created, false);
    assert.equal(await code(jobs.result(a, kept.job.id)), "result-expired");

    h.clock.offsetMs += 23 * 86400_000;
    const purged = await w.cleanup();
    assert.ok(purged.records >= 1);
    assert.equal(await code(jobs.get(a, kept.job.id)), "job-not-found");
  });

  test("operators list and cancel every Job", async () => {
    await c.connections.setPersonalCredential(b, "work", "bob-key");
    await submit(a, "echo", 1, "o1");
    const bobs = await submit(b, "echo", 1, "o2");
    assert.equal((await jobs.list({})).length, 2);
    const op = { ...a, kind: "operator" as const };
    assert.equal((await jobs.cancelAny(op, bobs.job.id)).state, "cancelled");
    const audit = await db
      .selectFrom("audit")
      .select(["action", "target"])
      .where("action", "=", "job.cancel")
      .execute();
    assert.deepEqual(audit, [{ action: "job.cancel", target: bobs.job.id }]);
  });
});
