import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "kysely";
import { createHttpApp } from "../src/http/app.js";
import { jobsApi } from "../src/jobs/api.js";
import { JobsService } from "../src/jobs/service.js";
import { JobsWorker } from "../src/jobs/worker.js";
import { command, eventually, jobDeclaration, jobsFixture, workerOptions } from "./jobs-fixture.js";

test("semantic admission commits once across pools; equal retained recovery bypasses selection and disabled execution; changed commands conflict", async () => {
  const f = await jobsFixture();
  try {
    const outcomes = await Promise.all([
      f.jobs.admit(f.alice.access, command("same", {})),
      f.jobs2.admit(f.alice.access, command("same", { value: "default" })),
    ]);
    assert.equal(outcomes.filter((o) => o.created).length, 1);
    assert.equal(outcomes[0]!.job.id, outcomes[1]!.job.id);
    assert.equal((await f.jobs.db.selectFrom("jobs").select("id").execute()).length, 1);
    await assert.rejects(f.jobs.admit(f.alice.access, command("same", { value: "different" })), {
      code: "submission-conflict",
    });
    await assert.rejects(
      f.jobs.admit(f.alice.access, command("same", { value: "default" }, f.connection.id)),
      { code: "submission-conflict" },
    );
    await f.connections.disconnect(f.alice.access, f.connection.id, 1);
    const retired = new JobsService({ ...f.jobs.options, declarations: [] });
    assert.equal((await retired.admit(f.alice.access, command("same", {}))).created, false);
    await assert.rejects(f.jobs.get(f.bob.access, outcomes[0]!.job.id), { status: 404 });
    await f.db
      .updateTable("tableau_sites")
      .set({ enabled: false })
      .where("id", "=", "site-row")
      .execute();
    await assert.rejects(retired.admit(f.alice.access, command("same", {})), { status: 403 });
  } finally {
    await f.close();
  }
});

test("actual API worker journey retains encrypted result after disconnect and hides it from another owner", async () => {
  const f = await jobsFixture();
  const worker = new JobsWorker(f.jobs, workerOptions);
  const app = await createHttpApp({
    db: f.db,
    core: f.core,
    extensions: [jobsApi(f.jobs, { cleanupMs: 1000 })],
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const root = app.listeningOrigin;
    const created = await fetch(`${root}/v1/apps/one/jobs`, {
      method: "POST",
      headers: { authorization: `Bearer ${f.alice.token}`, "content-type": "application/json" },
      body: command("http"),
    });
    assert.equal(created.status, 202);
    const job = (await created.json()) as { id: string };
    await worker.start();
    await eventually(
      () => f.jobs.get(f.alice.access, job.id),
      (j) => j.state === "succeeded",
    );
    const stored = await f.jobs.db
      .selectFrom("job_payloads")
      .selectAll()
      .where("job_id", "=", job.id)
      .execute();
    assert.deepEqual(
      stored.map((p) => p.kind),
      ["result"],
    );
    assert.equal(stored[0]!.body.includes(Buffer.from("hello")), false);
    await f.connections.disconnect(f.alice.access, f.connection.id, 1);
    const result = await fetch(`${root}/v1/apps/two/jobs/${job.id}/result`, {
      headers: { authorization: `Bearer ${f.alice.token}` },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { value: "hello" });
    assert.equal((await f.jobs.get({ ...f.alice.access, appId: "two" }, job.id)).appId, "one");
    assert.equal(
      (
        await fetch(`${root}/v1/apps/two/jobs/${job.id}`, {
          headers: { authorization: `Bearer ${f.bob.token}` },
        })
      ).status,
      404,
    );
    await f.jobs.db
      .updateTable("job_payloads")
      .set({ body: Buffer.from("corrupt") })
      .where("job_id", "=", job.id)
      .execute();
    await assert.rejects(f.jobs.result(f.alice.access, job.id), { code: "invalid-job-payload" });
  } finally {
    await worker.close();
    await app.close();
    await f.close();
  }
});

test("two worker incarnations claim once and expired initial claims never invoke again", async () => {
  const f = await jobsFixture();
  try {
    const admitted = await f.jobs.admit(f.alice.access, command("claim"));
    const hint = (await f.jobs.row(admitted.job.id))!;
    const claims = await Promise.all([
      f.jobs.claim(hint, "execute", "first", 100),
      f.jobs2.claim(hint, "execute", "second", 100),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    await f.jobs.db
      .updateTable("jobs")
      .set({ lease_until: sql<Date>`clock_timestamp()` })
      .where("id", "=", hint.id)
      .execute();
    await f.jobs2.controls(10, 1000);
    const current = await f.jobs.row(hint.id);
    assert.equal(current!.state, "failed");
    assert.equal(current!.error!.code, "interrupted");
    assert.equal(await f.jobs.claim(current!, "execute", "replacement", 100), null);
  } finally {
    await f.close();
  }
});

test("publication rechecks database wall time after a lock wait and rejects deadline/lease equality", async () => {
  const f = await jobsFixture();
  try {
    for (const field of ["lease_until", "deadline"] as const) {
      const job = await f.jobs.admit(f.alice.access, command(field));
      const claim = (await f.jobs.claim((await f.jobs.row(job.job.id))!, "execute", "old", 1000))!;
      const prepared = await f.jobs.prepareResult(claim, { value: "late" });
      let unlock!: () => void;
      let locked!: () => void;
      const acquired = new Promise<void>((resolve) => (locked = resolve));
      const held = new Promise<void>((resolve) => (unlock = resolve));
      const lock = f.jobs2.db.transaction().execute(async (tx) => {
        await tx.selectFrom("jobs").select("id").where("id", "=", claim.id).forUpdate().execute();
        await tx
          .updateTable("jobs")
          .set({ [field]: sql<Date>`clock_timestamp()` })
          .where("id", "=", claim.id)
          .execute();
        locked();
        await held;
      });
      await acquired;
      const publication = f.jobs.publish(
        claim,
        { token: claim.claim_token!, incarnation: "old" },
        { kind: "complete", result: { value: "late" } },
        { result: prepared },
        1000,
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      unlock();
      await lock;
      assert.equal(await publication, false);
      await f.jobs.controls(10, 1000);
      assert.equal((await f.jobs.get(f.alice.access, claim.id)).state, "failed");
    }
  } finally {
    await f.close();
  }
});

test("queued cancel races start atomically; saturated execution still settles control without claiming more work", async () => {
  let release!: () => void;
  const stopped = new Promise<void>((resolve) => (release = resolve));
  const f = await jobsFixture([
    {
      ...jobDeclaration,
      handler: async (input) => {
        await stopped;
        return { kind: "complete", result: input };
      },
    },
  ]);
  const worker = new JobsWorker(f.jobs, workerOptions);
  try {
    const first = await f.jobs.admit(f.alice.access, command("busy"));
    const second = await f.jobs.admit(f.alice.access, command("queued"));
    await worker.start();
    await eventually(
      () => f.jobs.get(f.alice.access, first.job.id),
      (j) => j.state === "running",
    );
    assert.equal(worker.activeExecutions, 1);
    const hint = (await f.jobs.row(second.job.id))!;
    await Promise.all([
      f.jobs.cancel(f.alice.access, second.job.id, 1000),
      f.jobs2.claim(hint, "execute", "racer", 1000),
    ]);
    await f.jobs.controls(20, 1000);
    assert.equal((await f.jobs.get(f.alice.access, second.job.id)).state, "cancelled");
    await f.jobs.cancel(f.alice.access, first.job.id, 1000);
    await f.jobs.controls(20, 1000);
    assert.equal((await f.jobs.get(f.alice.access, first.job.id)).state, "cancelled");
    assert.equal(worker.activeExecutions, 1); // Terminal metadata is not stopped code.
    release();
    await eventually(
      async () => worker.activeExecutions,
      (n) => n === 0,
    );
    assert.equal((await f.jobs.get(f.alice.access, first.job.id)).state, "cancelled");
  } finally {
    release();
    await worker.close();
    await f.close();
  }
});

test("only explicitly returned settled failures retry finitely, keeping their original deadline", async () => {
  let calls = 0;
  const f = await jobsFixture([
    {
      ...jobDeclaration,
      retry: { delaysMs: [5] },
      handler: async () => {
        calls++;
        return {
          kind: "failed",
          error: { code: "settled", message: "Provider explicitly rejected" },
          retryable: true,
        };
      },
    },
  ]);
  const worker = new JobsWorker(f.jobs, workerOptions);
  try {
    const job = await f.jobs.admit(f.alice.access, command("retry"));
    await worker.start();
    const row = await eventually(
      () => f.jobs.row(job.job.id),
      (j) => j?.state === "failed",
    );
    assert.equal(calls, 2);
    assert.equal(row!.attempts, 2);
    assert.equal(row!.deadline!.getTime() - row!.started_at!.getTime(), 86400000);
  } finally {
    await worker.close();
    await f.close();
  }
  let uncertain = 0;
  const g = await jobsFixture([
    {
      ...jobDeclaration,
      retry: { delaysMs: [1] },
      handler: async () => {
        uncertain++;
        throw new Error("after send");
      },
    },
  ]);
  const w = new JobsWorker(g.jobs, workerOptions);
  try {
    const job = await g.jobs.admit(g.alice.access, command("unknown"));
    await w.start();
    await eventually(
      () => g.jobs.get(g.alice.access, job.job.id),
      (j) => j.state === "failed",
    );
    assert.equal(uncertain, 1);
  } finally {
    await w.close();
    await g.close();
  }
});

test("result and metadata expiry are fixed; cleanup deletes bodies and ends retained-key deduplication", async () => {
  const f = await jobsFixture();
  const worker = new JobsWorker(f.jobs, workerOptions);
  try {
    const limited = new JobsService({
      ...f.jobs.options,
      limits: { resultRetentionMs: 200, metadataRetentionMs: 500 },
    });
    const job = await limited.admit(f.alice.access, command("retained"));
    await worker.start();
    await eventually(
      () => limited.get(f.alice.access, job.job.id),
      (j) => j.state === "succeeded",
    );
    const row = (await limited.row(job.job.id))!;
    const expiry = row.result_expires_at!.getTime();
    await limited.result(f.alice.access, job.job.id);
    assert.equal((await limited.row(job.job.id))!.result_expires_at!.getTime(), expiry);
    await new Promise((resolve) => setTimeout(resolve, 210));
    await assert.rejects(limited.result(f.alice.access, job.job.id), { status: 410 });
    await limited.retain(20);
    assert.equal(
      (
        await limited.db
          .selectFrom("job_payloads")
          .select("kind")
          .where("job_id", "=", job.job.id)
          .execute()
      ).length,
      0,
    );
    assert.equal((await limited.admit(f.alice.access, command("retained"))).created, false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await limited.retain(20);
    assert.equal((await limited.admit(f.alice.access, command("retained"))).created, true);
  } finally {
    await worker.close();
    await f.close();
  }
});

test("freshness-only start blockage stays queued and same-account reauthorization resumes the immutable selection", async () => {
  const f = await jobsFixture();
  try {
    const job = await f.jobs.admit(f.alice.access, command("freshness"));
    await f.db
      .updateTable("provider_registrations")
      .set({ reauth_seconds: 1 })
      .where("id", "=", "fixture")
      .execute();
    await f.db
      .updateTable("connections")
      .set({
        last_connector_reauth_at: new Date(Date.now() - 2000),
        state: "reauthorization-required",
      })
      .where("id", "=", f.connection.id)
      .execute();
    assert.equal(
      await f.jobs.claim((await f.jobs.row(job.job.id))!, "execute", "before-reauth", 1000),
      null,
    );
    const blocked = (await f.jobs.row(job.job.id))!;
    assert.equal(blocked.state, "queued");
    assert.equal(blocked.blocked_reason, "reauthorization-required");
    await f.db
      .updateTable("connections")
      .set({ last_connector_reauth_at: new Date(), state: "active" })
      .where("id", "=", f.connection.id)
      .execute();
    await f.jobs.db
      .updateTable("jobs")
      .set({ due_at: sql<Date>`clock_timestamp()` })
      .where("id", "=", job.job.id)
      .execute();
    const claimed = await f.jobs.claim(
      (await f.jobs.row(job.job.id))!,
      "execute",
      "after-reauth",
      1000,
    );
    assert.ok(claimed);
    assert.equal(claimed.connection_id, f.connection.id);
    assert.equal(claimed.authority_generation, 1);
  } finally {
    await f.close();
  }
});

test("an eligible original success wins cancellation without scheduling remote rollback", async () => {
  const f = await jobsFixture([
    {
      ...jobDeclaration,
      external: {
        contextSchema: jobDeclaration.inputSchema,
        contextLimitBytes: 1000,
        cancel: async () => "confirmed",
      },
    },
  ]);
  try {
    const job = await f.jobs.admit(f.alice.access, command("success-wins"));
    const claim = (await f.jobs.claim((await f.jobs.row(job.job.id))!, "execute", "winner", 1000))!;
    await f.jobs.cancel(f.alice.access, claim.id, 1000);
    const result = await f.jobs.prepareResult(claim, { value: "done" });
    assert.equal(
      await f.jobs.publish(
        claim,
        { token: claim.claim_token!, incarnation: "winner" },
        { kind: "complete", result: { value: "done" } },
        { result },
        1000,
      ),
      true,
    );
    const final = await f.jobs.cancel(f.alice.access, claim.id, 1000);
    assert.equal(final.state, "succeeded");
    assert.equal(final.cancellation.requested, true);
    assert.equal(final.cancellation.remote, "not-requested");
    assert.equal((await f.jobs.cleanupCandidates(10)).length, 0);
  } finally {
    await f.close();
  }
});

test("equal recovery uses retained limits and comparison capacity before allocating new Job payload resources", async () => {
  const f = await jobsFixture();
  try {
    const raw = command("recovery-budget");
    const job = await f.jobs.admit(f.alice.access, raw);
    const limited = new JobsService({
      ...f.jobs.options,
      limits: { inputBytes: 1, resultBytes: 1, executionSeconds: 1 },
    });
    assert.equal(
      (await limited.admit(f.alice.access, command("recovery-budget"))).job.id,
      job.job.id,
    );
    await assert.rejects(limited.admit(f.alice.access, command("new-over-reduced-limit")), {
      code: "invalid-job-payload",
    });
    const release = f.payloads.reserve(f.payloads.workingBytes - raw.length * 8 - 1);
    try {
      assert.equal((await f.jobs.admit(f.alice.access, command("recovery-budget"))).created, false);
    } finally {
      release();
    }
  } finally {
    await f.close();
  }
});

test("current disclosure is rechecked after outside-lock decryption before an HTTP result is released", async () => {
  const f = await jobsFixture();
  const worker = new JobsWorker(f.jobs, workerOptions);
  const app = await createHttpApp({
    db: f.db,
    core: f.core,
    extensions: [jobsApi(f.jobs, { cleanupMs: 1000 })],
  });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const job = await f.jobs.admit(f.alice.access, command("revocation-race"));
    await worker.start();
    await eventually(
      () => f.jobs.get(f.alice.access, job.job.id),
      (j) => j.state === "succeeded",
    );
    const open = f.payloads.open.bind(f.payloads);
    f.payloads.open = async (...args) => {
      const value = await open(...args);
      await f.db
        .updateTable("tableau_sites")
        .set({ enabled: false })
        .where("id", "=", "site-row")
        .execute();
      return value;
    };
    const result = await fetch(`${origin}/v1/apps/one/jobs/${job.job.id}/result`, {
      headers: { authorization: `Bearer ${f.alice.token}` },
    });
    assert.equal(result.status, 403);
    assert.equal((await result.text()).includes("hello"), false);
  } finally {
    await worker.close();
    await app.close();
    await f.close();
  }
});

test("HTTP admission authenticates before waiting for a large body to finish", async () => {
  const { request } = await import("node:http");
  const f = await jobsFixture();
  const app = await createHttpApp({
    db: f.db,
    core: f.core,
    extensions: [jobsApi(f.jobs, { cleanupMs: 1000 })],
  });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    await new Promise<void>((resolve, reject) => {
      const req = request(
        `${origin}/v1/apps/one/jobs`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
        },
        (response) => {
          assert.equal(response.statusCode, 401);
          response.resume();
          req.destroy();
          resolve();
        },
      );
      req.setTimeout(1000, () => {
        req.destroy();
        reject(new Error("API waited for unauthenticated body completion"));
      });
      req.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
      });
      req.write('{"input":"');
    });
    assert.equal((await f.jobs.db.selectFrom("jobs").select("id").execute()).length, 0);
  } finally {
    await app.close();
    await f.close();
  }
});

test("overlapping local wakeups cannot claim beyond actual available execution capacity", async () => {
  let releaseHandler!: () => void;
  const running = new Promise<void>((resolve) => (releaseHandler = resolve));
  const f = await jobsFixture([
    {
      ...jobDeclaration,
      handler: async (input) => {
        await running;
        return { kind: "complete", result: input };
      },
    },
  ]);
  const worker = new JobsWorker(f.jobs, workerOptions);
  let releaseClaim!: () => void;
  let signalClaim!: () => void;
  const commitBoundary = new Promise<void>((resolve) => (signalClaim = resolve));
  const waitBoundary = new Promise<void>((resolve) => (releaseClaim = resolve));
  try {
    await f.jobs.admit(f.alice.access, command("local-one"));
    await f.jobs.admit(f.alice.access, command("local-two"));
    const original = f.jobs.claim.bind(f.jobs);
    let held = false;
    f.jobs.claim = async (...args) => {
      const row = await original(...args);
      if (row && !held) {
        held = true;
        signalClaim();
        await waitBoundary;
      }
      return row;
    };
    const first = worker.scan();
    await commitBoundary;
    const overlapping = worker.scan();
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseClaim();
    await Promise.all([first, overlapping]);
    assert.equal(worker.activeExecutions, 1);
    assert.equal(
      (await f.jobs.db.selectFrom("jobs").select("id").where("state", "=", "queued").execute())
        .length,
      1,
    );
  } finally {
    releaseClaim?.();
    releaseHandler();
    await worker.close();
    await f.close();
  }
});

test("physical payload capacity is reserved before claim while cancellation controls remain available", async () => {
  const f = await jobsFixture();
  const worker = new JobsWorker(f.jobs, workerOptions);
  let release = () => {};
  try {
    const first = await f.jobs.admit(f.alice.access, command("memory-cancel"));
    const second = await f.jobs.admit(f.alice.access, command("memory-wait"));
    release = f.payloads.reserve(f.payloads.workingBytes);
    await worker.scan();
    assert.equal((await f.jobs.row(second.job.id))!.attempts, 0);
    assert.equal(worker.activeExecutions, 0);
    await f.jobs.cancel(f.alice.access, first.job.id, 1000);
    await worker.scan();
    assert.equal((await f.jobs.get(f.alice.access, first.job.id)).state, "cancelled");
    release();
    await worker.scan();
    await eventually(
      () => f.jobs.get(f.alice.access, second.job.id),
      (j) => j.state === "succeeded",
    );
  } finally {
    release();
    await worker.close();
    await f.close();
  }
});

test("Job registration rejects validation semantics that cannot survive retained comparison", async () => {
  const { z } = await import("zod");
  const f = await jobsFixture();
  try {
    for (const inputSchema of [
      z.string().refine((value) => value !== "rejected"),
      z.object({ value: z.string() }),
      z.coerce.number(),
      z.string().trim(),
      z.union([z.strictObject({ value: z.string().default("x") }), z.number()]),
    ])
      assert.throws(
        () =>
          new JobsService({
            ...f.jobs.options,
            declarations: [{ ...jobDeclaration, inputSchema }],
          }),
      );
  } finally {
    await f.close();
  }
});

test("canonical browse uses owner-filtered cross-app pages and continuations bound to owner and filters", async () => {
  const { jobCollectionSchema } = await import("../src/public/schemas.js");
  const f = await jobsFixture();
  const app = await createHttpApp({
    db: f.db,
    core: f.core,
    extensions: [jobsApi(f.jobs, { cleanupMs: 1000 })],
  });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const first = await f.jobs.admit(f.alice.access, command("page-one"));
    const second = await f.jobs.admit({ ...f.alice.access, appId: "two" }, command("page-two"));
    const page = jobCollectionSchema.parse(
      await fetch(`${origin}/v1/apps/two/jobs?limit=1`, {
        headers: { authorization: `Bearer ${f.alice.token}` },
      }).then((response) => response.json()),
    );
    assert.equal(page.items.length, 1);
    assert.ok(page.next);
    const next = jobCollectionSchema.parse(
      await f.jobs.list(f.alice.access, { limit: 1, next: page.next }),
    );
    assert.equal(next.items.length, 1);
    assert.deepEqual(
      new Set([...page.items, ...next.items].map((j) => j.id)),
      new Set([first.job.id, second.job.id]),
    );
    await assert.rejects(f.jobs.list(f.bob.access, { next: page.next }), {
      code: "invalid-continuation",
    });
    await assert.rejects(f.jobs.list(f.alice.access, { next: page.next, appId: "one" }), {
      code: "invalid-continuation",
    });
    assert.deepEqual((await f.jobs.list(f.bob.access)).items, []);
    const invalid = await fetch(`${origin}/v1/apps/one/jobs?limit=101`, {
      headers: { authorization: `Bearer ${f.alice.token}` },
    });
    assert.equal(invalid.status, 400);
    await invalid.text();
  } finally {
    await app.close();
    await f.close();
  }
});

test("unsupported JavaScript result values fail explicitly rather than being silently dropped", async () => {
  const { z } = await import("zod");
  const f = await jobsFixture([
    {
      ...jobDeclaration,
      resultSchema: z.unknown(),
      handler: async () => ({
        kind: "complete",
        result: { value: "known", unsupported: undefined },
      }),
    },
  ]);
  const worker = new JobsWorker(f.jobs, workerOptions);
  try {
    const job = await f.jobs.admit(f.alice.access, command("unsupported-json"));
    await worker.start();
    const outcome = await eventually(
      () => f.jobs.get(f.alice.access, job.job.id),
      (j) => j.state === "failed",
    );
    assert.equal(outcome.error!.code, "invalid-outcome");
    assert.equal(outcome.result.availability, "none");
  } finally {
    await worker.close();
    await f.close();
  }
});
