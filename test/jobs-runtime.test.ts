import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ExecutionLifetime } from "../src/runtime/lifetime.js";
import { superviseWorker } from "../src/runtime/watchdog.js";

test("lifetime aborts and awaits owned resource disposal before returning reusable capacity", async () => {
  let dispose = false;
  let terminate = false;
  const life = new ExecutionLifetime({
    cleanupMs: 1000,
    requestTermination: () => {
      terminate = true;
    },
  });
  life.own(async () => {
    assert.equal(life.signal.aborted, true);
    await delay(20);
    dispose = true;
  });
  const value = await life.run(async () => 42);
  assert.equal(value, 42);
  assert.equal(dispose, true);
  assert.equal(terminate, false);
});

test("a timeout does not return while an uncooperative handler still owns capacity", async () => {
  let terminate = false;
  let returned = false;
  const life = new ExecutionLifetime({
    cleanupMs: 10,
    requestTermination: () => {
      terminate = true;
    },
  });
  void life
    .run(async () => new Promise<never>(() => {}))
    .finally(() => {
      returned = true;
    });
  life.abort();
  await delay(40);
  assert.equal(terminate, true);
  assert.equal(returned, false);
});

for (const mode of ["blocked", "promise"]) {
  test(`independent watchdog confirms actual ${mode} worker process exit before reuse`, {
    timeout: 10000,
  }, async () => {
    const child = fork(new URL("./jobs-fixtures/runtime-child.ts", import.meta.url), [mode], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let released = false;
    let ready = false;
    child.on("message", (message) => {
      const value = message as { type: string };
      if (value.type === "released") released = true;
      if (value.type === "ready") ready = true;
    });
    const watchdog = superviseWorker(child, { heartbeatMs: 1000, terminateGraceMs: 40 });
    try {
      const exit = await watchdog.exited;
      assert.equal(ready, true);
      assert.equal(exit.signal, "SIGKILL");
      assert.equal(released, false);
      assert.equal(child.exitCode === null && child.signalCode === null, false);
      assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" });
    } finally {
      watchdog.stop();
    }
  });
}

test("blocked durable worker death interrupts siblings with honest unknown effects and no replay", {
  timeout: 15000,
}, async () => {
  const { createServer } = await import("node:http");
  const { jobsFixture, command, eventually } = await import("./jobs-fixture.js");
  const f = await jobsFixture();
  let effects = 0;
  const upstream = createServer((request, response) => {
    effects++;
    request.resume();
    response.end("effect accepted");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  let child: ReturnType<typeof fork> | undefined;
  try {
    const first = await f.jobs.admit(f.alice.access, command("blocked-child", { value: "block" }));
    const second = await f.jobs.admit(
      f.alice.access,
      command("sibling-child", { value: "sibling" }),
    );
    child = fork(new URL("./jobs-fixtures/durable-child.ts", import.meta.url), [], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: {
        ...process.env,
        NODE_ENV: "test",
        CONTROL_DATABASE_URL: f.config.DATABASE_URL,
        DATABASE_URL: f.config.DATABASE_URL,
        SERVICE_ORIGIN: f.config.SERVICE_ORIGIN,
        ENCRYPTION_ACTIVE_KEY_ID: f.config.ENCRYPTION_ACTIVE_KEY_ID,
        ENCRYPTION_KEYS: JSON.stringify(
          Object.fromEntries([...f.config.keys].map(([id, key]) => [id, key.toString("hex")])),
        ),
        JOB_TEST_UPSTREAM: `http://127.0.0.1:${address.port}/`,
      },
    });
    const watchdog = superviseWorker(child, { heartbeatMs: 1200, terminateGraceMs: 50 });
    await eventually(
      async () => effects,
      (n) => n === 2,
    );
    await watchdog.exited;
    assert.throws(() => process.kill(child!.pid!, 0), { code: "ESRCH" });
    await f.jobs.controls(20, 1000);
    for (const id of [first.job.id, second.job.id]) {
      const job = await f.jobs.get(f.alice.access, id);
      assert.equal(job.state, "failed");
      assert.equal(job.error!.code, "interrupted");
      assert.equal(
        await f.jobs.claim((await f.jobs.row(id))!, "execute", "replacement", 1000),
        null,
      );
    }
    assert.equal(effects, 2);
  } finally {
    child?.kill("SIGKILL");
    await new Promise<void>((resolve, reject) =>
      upstream.close((e) => (e ? reject(e) : resolve())),
    );
    await f.close();
  }
});
