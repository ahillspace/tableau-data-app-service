import { ExecutionLifetime } from "../../src/runtime/lifetime.js";
import { requestWorkerTermination, startWorkerHeartbeat } from "../../src/runtime/watchdog.js";

startWorkerHeartbeat(10);
process.on("SIGTERM", () => {}); // Prove the independent supervisor escalates.
if (process.argv[2] === "blocked") {
  process.send?.({ type: "ready" });
  setTimeout(() => {
    while (true) {}
  }, 5);
} else {
  const lifetime = new ExecutionLifetime({
    cleanupMs: 30,
    requestTermination: requestWorkerTermination,
  });
  let released = false;
  void lifetime
    .run(async () => {
      process.send?.({ type: "ready" });
      await new Promise(() => {});
      released = true;
    })
    .finally(() => process.send?.({ type: "released", released }));
  setTimeout(() => lifetime.abort(), 10);
}
