import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { sql } from "kysely";
import { z } from "zod";
import { createHttpApp } from "../src/http/app.js";
import { ServiceError } from "../src/http/errors.js";
import { jobsApi } from "../src/jobs/api.js";
import type { CallbackEvidence, JobDeclaration } from "../src/jobs/types.js";
import { JobsWorker } from "../src/jobs/worker.js";
import { command, eventually, jobDeclaration, jobsFixture, workerOptions } from "./jobs-fixture.js";

const task = {
  externalId: "task-one",
  accountKey: "verified-fixture-account",
  context: { poll: "one" },
};
const proof = (body: string) =>
  createHmac("sha256", "test-source-verifier").update(body).digest("hex");
const callback = {
  route: "tasks",
  verify: async (raw: Uint8Array, headers: Headers): Promise<CallbackEvidence> => {
    const body = Buffer.from(raw).toString();
    const actual = Buffer.from(headers.get("x-proof") ?? "", "hex");
    const expected = Buffer.from(proof(body), "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new ServiceError(401, "callback-unverified", "Task callback is unverified");
    return JSON.parse(body);
  },
};
const external = {
  contextSchema: z.strictObject({ poll: z.string() }),
  contextLimitBytes: 1000,
  callback,
};

for (const attachment of [
  "handler",
  "pending callback",
  "terminal callback",
  "different task",
] as const)
  for (const terminalKind of ["succeeded", "failed"] as const)
    test(`terminal ${terminalKind} callback resolves after ${attachment} wins task attachment`, {
      timeout: 15000,
    }, async (t) => {
      const handlerRelease = Promise.withResolvers<void>();
      const callbackRelease = Promise.withResolvers<void>();
      let starts = 0;
      let preparing = false;
      const declaration: JobDeclaration = {
        ...jobDeclaration,
        external,
        handler: async () => {
          starts++;
          await handlerRelease.promise;
          return { kind: "waiting", task };
        },
      };
      const f = await jobsFixture([declaration]);
      const worker = new JobsWorker(f.jobs2, workerOptions);
      const app = await createHttpApp({
        db: f.db,
        core: f.core,
        extensions: [jobsApi(f.jobs, { cleanupMs: 1000 })],
      });
      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      const prepareTask = f.jobs.prepareTask.bind(f.jobs);
      t.mock.method(f.jobs, "prepareTask", async (...args: Parameters<typeof prepareTask>) => {
        // Hold only outside-lock payload preparation, after the real null-task read.
        assert.equal(args[0].task_id, null);
        const prepared = await prepareTask(...args);
        preparing = true;
        await callbackRelease.promise;
        return prepared;
      });
      const post = async (evidence: CallbackEvidence) => {
        const raw = JSON.stringify(evidence);
        return fetch(`${origin}/v1/providers/fixture/tasks/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-proof": proof(raw) },
          body: raw,
        });
      };
      try {
        const job = await f.jobs.admit(f.alice.access, command("attachment-race"));
        await worker.start();
        await eventually(
          async () => starts,
          (count) => count === 1,
        );
        const running = (await f.jobs.row(job.job.id))!;
        assert.equal(running.state, "running");
        assert.equal(running.task_id, null);
        const evidence: CallbackEvidence = {
          correlation: running.callback_correlation!,
          task: { ...task, context: { poll: "terminal-callback" } },
          outcome:
            terminalKind === "succeeded"
              ? { kind: "succeeded", result: { value: "committed" } }
              : {
                  kind: "failed",
                  error: { code: "provider-failed", message: "Settled failure" },
                  result: { value: "committed" },
                },
        };
        const response = post(evidence);
        await eventually(async () => preparing, Boolean);
        const winnerTask =
          attachment === "different task" ? { ...task, externalId: "other-task" } : task;
        if (attachment === "handler") handlerRelease.resolve();
        else {
          const raw = JSON.stringify({
            ...evidence,
            task: winnerTask,
            outcome:
              attachment === "terminal callback"
                ? { kind: "succeeded", result: { value: "winner" } }
                : { kind: "pending" },
          });
          assert.equal(
            await f.jobs2.callback(
              declaration,
              Buffer.from(raw),
              new Headers({ "x-proof": proof(raw) }),
            ),
            "accepted",
          );
        }
        const attached = await eventually(
          () => f.jobs2.row(job.job.id),
          (row) =>
            row?.state === (attachment === "terminal callback" ? "succeeded" : "waiting-provider"),
        );
        assert.equal(attached!.has_result, attachment === "terminal callback");
        callbackRelease.resolve();
        const accepted = await response;
        if (attachment === "different task") {
          assert.equal(accepted.status, 404);
          await accepted.arrayBuffer();
          const current = (await f.jobs2.row(job.job.id))!;
          assert.equal(current.state, "waiting-provider");
          assert.equal(current.has_result, false);
          assert.deepEqual(await f.jobs2.task(current), winnerTask);
          assert.equal(starts, 1);
          return;
        }
        assert.equal(accepted.status, 200);
        assert.deepEqual(await accepted.json(), {
          status: attachment === "terminal callback" ? "duplicate" : "accepted",
        });
        // Acknowledgment must mean the result and terminal state are already durable.
        const terminal = (await f.jobs2.row(job.job.id))!;
        assert.equal(
          terminal.state,
          attachment === "terminal callback" ? "succeeded" : terminalKind,
        );
        assert.equal(terminal.has_result, true);
        assert.equal(terminal.claim_token, null);
        const result = { value: attachment === "terminal callback" ? "winner" : "committed" };
        assert.deepEqual(await f.jobs2.result(f.alice.access, job.job.id), result);
        assert.deepEqual(await f.jobs2.task(terminal), task);
        if (attachment === "terminal callback") {
          assert.equal(terminal.completed_at!.getTime(), attached!.completed_at!.getTime());
          assert.equal(
            terminal.result_expires_at!.getTime(),
            attached!.result_expires_at!.getTime(),
          );
        }
        handlerRelease.resolve();
        await eventually(
          async () => worker.activeExecutions,
          (count) => count === 0,
        );
        const duplicate = await post({
          ...evidence,
          outcome: { kind: "succeeded", result: { value: "replacement" } },
        });
        assert.equal(duplicate.status, 200);
        assert.deepEqual(await duplicate.json(), { status: "duplicate" });
        const retained = (await f.jobs2.row(job.job.id))!;
        assert.equal(retained.completed_at!.getTime(), terminal.completed_at!.getTime());
        assert.equal(retained.result_expires_at!.getTime(), terminal.result_expires_at!.getTime());
        assert.deepEqual(await f.jobs2.result(f.alice.access, job.job.id), result);
        assert.equal(starts, 1);
      } finally {
        callbackRelease.resolve();
        handlerRelease.resolve();
        await worker.close();
        await app.close();
        await f.close();
      }
    });

test("real provider HTTP can callback before submit returns; verified duplicate/late callbacks fence handlers without result regression", async () => {
  const declaration: JobDeclaration = {
    ...jobDeclaration,
    external,
    handler: async (input, context) => {
      const response = await context.request({
        endpoint: "api",
        path: "/submit",
        method: "POST",
        body: JSON.stringify(context.callbackBinding),
      });
      await response.text();
      return { kind: "waiting", task };
    },
  };
  const f = await jobsFixture([declaration]);
  const worker = new JobsWorker(f.jobs, workerOptions);
  const app = await createHttpApp({
    db: f.db,
    core: f.core,
    extensions: [jobsApi(f.jobs, { cleanupMs: 1000 })],
  });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  f.jobs.options.callbackOrigin = origin;
  let correlation = "";
  let callbacks = 0;
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const binding = JSON.parse(Buffer.concat(chunks).toString());
    correlation = binding.correlation;
    const body = JSON.stringify({
      correlation,
      task,
      outcome: { kind: "succeeded", result: { value: "early" } },
    });
    const accepted = await fetch(binding.callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-proof": proof(body) },
      body,
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { status: "accepted" });
    callbacks++;
    response.end("submitted");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No port");
  f.provider.endpoints = {
    api: {
      baseUrl: `http://127.0.0.1:${address.port}/`,
      allowHttp: true,
      privateCidrs: ["127.0.0.1/32"],
    },
  };
  try {
    const job = await f.jobs.admit(f.alice.access, command("early"));
    await worker.start();
    await eventually(
      () => f.jobs.get(f.alice.access, job.job.id),
      (j) => j.state === "succeeded",
    );
    await eventually(
      async () => worker.activeExecutions,
      (n) => n === 0,
    );
    assert.equal(callbacks, 1);
    assert.deepEqual(await f.jobs.result(f.alice.access, job.job.id), { value: "early" });
    const post = async (body: object) => {
      const raw = JSON.stringify(body);
      return fetch(`${origin}/v1/providers/fixture/tasks/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-proof": proof(raw) },
        body: raw,
      });
    };
    await f.connections.disconnect(f.alice.access, f.connection.id, 1);
    assert.deepEqual(
      await (
        await post({
          correlation,
          task,
          outcome: { kind: "succeeded", result: { value: "changed" } },
        })
      ).json(),
      { status: "duplicate" },
    );
    assert.equal(
      (
        await post({
          correlation,
          task: { ...task, accountKey: "other-account" },
          outcome: { kind: "succeeded", result: { value: "wrong" } },
        })
      ).status,
      404,
    );
    assert.deepEqual(await f.jobs.result(f.alice.access, job.job.id), { value: "early" });
    const row = await f.jobs.row(job.job.id);
    assert.equal(row!.claim_token, null);
  } finally {
    await worker.close();
    await app.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((e) => (e ? reject(e) : resolve())),
    );
    await f.close();
  }
});

test("persisted external waits release execution capacity; observation lease recovery never resubmits and unavailable account remains blocked", async () => {
  let starts = 0;
  let observations = 0;
  const declaration: JobDeclaration = {
    ...jobDeclaration,
    external: {
      ...external,
      observe: async () => {
        observations++;
        return { kind: "pending", nextCheckAt: new Date(Date.now() + 100).toISOString() };
      },
    },
    handler: async (input) => {
      starts++;
      return (input as { value: string }).value === "sync"
        ? { kind: "complete", result: input }
        : { kind: "waiting", task, nextCheckAt: new Date(Date.now() + 50).toISOString() };
    },
  };
  const f = await jobsFixture([declaration]);
  const worker = new JobsWorker(f.jobs, workerOptions);
  try {
    const first = await f.jobs.admit(f.alice.access, command("external"));
    await worker.start();
    await eventually(
      () => f.jobs.get(f.alice.access, first.job.id),
      (j) => j.state === "waiting-provider",
    );
    await eventually(
      async () => worker.activeExecutions,
      (n) => n === 0,
    );
    const second = await f.jobs.admit(f.alice.access, command("can-run", { value: "sync" }));
    worker.wake();
    await eventually(
      () => f.jobs.get(f.alice.access, second.job.id),
      (j) => j.state === "succeeded",
    );
    await eventually(
      async () => observations,
      (n) => n >= 1,
    );
    await worker.close();
    await f.jobs.db
      .updateTable("jobs")
      .set({
        due_at: sql<Date>`clock_timestamp()`,
        claim_token: "expired-observer",
        incarnation: "old",
        claim_kind: "observe",
        lease_until: sql<Date>`clock_timestamp()`,
      })
      .where("id", "=", first.job.id)
      .execute();
    await f.jobs.controls(20, 1000);
    const waiting = (await f.jobs.row(first.job.id))!;
    assert.equal(waiting.state, "waiting-provider");
    assert.equal(waiting.claim_token, null);
    assert.ok(await f.jobs2.claim(waiting, "observe", "replacement", 1000));
    await f.jobs.db
      .updateTable("jobs")
      .set({
        claim_token: null,
        incarnation: null,
        lease_until: null,
        claim_kind: null,
        due_at: sql<Date>`clock_timestamp()`,
      })
      .where("id", "=", first.job.id)
      .execute();
    await f.connections.disconnect(f.alice.access, f.connection.id, 1);
    assert.equal(
      await f.jobs.claim((await f.jobs.row(first.job.id))!, "observe", "after-disconnect", 1000),
      null,
    );
    assert.equal(
      (await f.jobs.get(f.alice.access, first.job.id)).blockedReason,
      "observation-authority-unavailable",
    );
    assert.equal(starts, 2);
    assert.ok(observations >= 1);
  } finally {
    await worker.close();
    await f.close();
  }
});

test("late task identity is accepted only for original invocation cleanup; issued uncertain remote cancellation is never dispatched twice", async () => {
  let cancelled = 0;
  const f = await jobsFixture([
    {
      ...jobDeclaration,
      external: {
        ...external,
        cancel: async () => {
          cancelled++;
          return "confirmed";
        },
      },
      handler: async () => ({ kind: "waiting", task }),
    },
  ]);
  try {
    const job = await f.jobs.admit(f.alice.access, command("race-cancel"));
    const claim = (await f.jobs.claim(
      (await f.jobs.row(job.job.id))!,
      "execute",
      "invoker",
      2000,
    ))!;
    await f.jobs.cancel(f.alice.access, claim.id, 1000);
    await f.jobs.controls(20, 1000);
    const body = await f.jobs.prepareTask(claim, task);
    assert.equal(
      await f.jobs.publish(
        claim,
        { token: "wrong", incarnation: "invoker" },
        { kind: "waiting", task },
        { task: body },
        1000,
      ),
      false,
    );
    assert.equal(
      await f.jobs.publish(
        claim,
        { token: claim.claim_token!, incarnation: "invoker" },
        { kind: "waiting", task },
        { task: body },
        1000,
      ),
      true,
    );
    const terminal = (await f.jobs.row(claim.id))!;
    const completed = terminal.completed_at!.getTime();
    const cleanup = (await f.jobs.claimCleanup(terminal, "cleaner", 1000))!;
    assert.ok(cleanup);
    const cleanupClaim = { token: cleanup.cleanup_token!, incarnation: "cleaner" };
    assert.equal(await f.jobs.issueCancel(cleanup, cleanupClaim), true);
    await f.jobs.db
      .updateTable("jobs")
      .set({ cleanup_lease: sql<Date>`clock_timestamp()` })
      .where("id", "=", claim.id)
      .execute();
    await f.jobs.controls(20, 1000);
    const current = (await f.jobs.row(claim.id))!;
    assert.equal(current.remote_status, "unconfirmed");
    assert.equal(current.completed_at!.getTime(), completed);
    assert.equal(await f.jobs.claimCleanup(current, "replacement", 1000), null);
    assert.equal(cancelled, 0);
  } finally {
    await f.close();
  }
});

test("verified failed callback preserves an explicitly validated safe partial result", async () => {
  const declaration: JobDeclaration = { ...jobDeclaration, external };
  const f = await jobsFixture([declaration]);
  try {
    const job = await f.jobs.admit(f.alice.access, command("partial"));
    const row = (await f.jobs.claim((await f.jobs.row(job.job.id))!, "execute", "partial", 1000))!;
    const raw = JSON.stringify({
      correlation: row.callback_correlation,
      task,
      outcome: {
        kind: "failed",
        error: { code: "provider-failed", message: "Provider reported failure" },
        result: { value: "partial" },
      },
    });
    assert.equal(
      await f.jobs.callback(declaration, Buffer.from(raw), new Headers({ "x-proof": proof(raw) })),
      "accepted",
    );
    assert.equal((await f.jobs.get(f.alice.access, row.id)).state, "failed");
    assert.deepEqual(await f.jobs.result(f.alice.access, row.id), { value: "partial" });
  } finally {
    await f.close();
  }
});

test("supported remote cancellation dispatches the recorded task once and reports provider evidence", async () => {
  let calls = 0;
  const received: string[] = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(Buffer.concat(chunks).toString());
    calls++;
    response.end("cancelled");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const declaration: JobDeclaration = {
    ...jobDeclaration,
    handler: async () => ({ kind: "waiting", task }),
    external: {
      ...external,
      cancel: async (original, context) => {
        const response = await context.request({
          endpoint: "api",
          method: "POST",
          path: "/cancel",
          body: original.externalId,
        });
        assert.equal(await response.text(), "cancelled");
        return "confirmed";
      },
    },
  };
  const f = await jobsFixture([declaration]);
  const worker = new JobsWorker(f.jobs, workerOptions);
  f.provider.endpoints = {
    api: {
      baseUrl: `http://127.0.0.1:${address.port}/`,
      allowHttp: true,
      privateCidrs: ["127.0.0.1/32"],
    },
  };
  try {
    const job = await f.jobs.admit(f.alice.access, command("cancel-confirmed"));
    await worker.start();
    await eventually(
      () => f.jobs.get(f.alice.access, job.job.id),
      (j) => j.state === "waiting-provider",
    );
    const cancelled = await f.jobs.cancel(f.alice.access, job.job.id, 1000);
    assert.equal(cancelled.state, "cancelled");
    await eventually(
      () => f.jobs.get(f.alice.access, job.job.id),
      (j) => j.cancellation.remote === "confirmed",
    );
    await worker.scan();
    assert.equal(calls, 1);
    assert.deepEqual(received, [task.externalId]);
  } finally {
    await worker.close();
    await f.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
