import { fork } from "node:child_process";
import { readApplicationConfig } from "./application-config.js";
import { superviseWorker } from "./runtime/watchdog.js";

async function main() {
  const settings = await readApplicationConfig(process.env);
  const child = fork(new URL("./worker-child.js", import.meta.url), [], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const supervisor = superviseWorker(child, {
    heartbeatMs: settings.worker.unresponsiveMs,
    terminateGraceMs: settings.worker.terminateGraceMs,
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => supervisor.stop());
  const result = await supervisor.exited;
  process.exitCode = result.code === 0 ? 0 : 1;
}
void main().catch(() => {
  process.stderr.write("Worker supervisor startup failed\n");
  process.exitCode = 1;
});
