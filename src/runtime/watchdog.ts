import type { ChildProcess } from "node:child_process";

export function startWorkerHeartbeat(intervalMs: number): () => void {
  if (!process.send || intervalMs <= 0)
    throw new Error("Worker requires its independent IPC supervisor");
  const send = () => process.send?.({ type: "worker:alive" });
  send();
  const timer = setInterval(send, intervalMs);
  return () => clearInterval(timer);
}
export function requestWorkerTermination(reason: string): void {
  if (!process.send) throw new Error("Worker termination requires its independent supervisor");
  process.send({ type: "worker:draining", reason });
}
export function superviseWorker(
  child: ChildProcess,
  options: { heartbeatMs: number; terminateGraceMs: number },
): { exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; stop(): void } {
  if (!child.pid || !child.connected || options.heartbeatMs <= 0 || options.terminateGraceMs <= 0)
    throw new Error("Invalid supervised worker");
  let lastBeat = performance.now();
  let terminating = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    if (terminating) return;
    terminating = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), options.terminateGraceMs);
    killTimer.unref();
  };
  const message = (value: unknown) => {
    if (!value || typeof value !== "object" || !("type" in value)) return;
    if (value.type === "worker:alive") lastBeat = performance.now();
    if (value.type === "worker:draining") terminate();
  };
  child.on("message", message);
  const timer = setInterval(
    () => {
      if (performance.now() - lastBeat >= options.heartbeatMs) terminate();
    },
    Math.max(1, Math.floor(options.heartbeatMs / 4)),
  );
  timer.unref();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      clearInterval(timer);
      if (killTimer) clearTimeout(killTimer);
      child.off("message", message);
      resolve({ code, signal });
    });
  });
  // stop requests termination too; it cannot relinquish supervision of a live child.
  return { exited, stop: terminate };
}
