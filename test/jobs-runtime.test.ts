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
