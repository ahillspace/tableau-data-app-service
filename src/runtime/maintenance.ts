import type { MaintenanceHook } from "../core-ports.js";

export function scheduleMaintenance(
  hook: MaintenanceHook,
  intervalMs: number,
  operationMs: number,
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  let completedAt: number | undefined;
  let failed = false;
  const tick = () => {
    if (controller.signal.aborted) return;
    active = hook
      .run(controller.signal)
      .then(() => {
        completedAt = Date.now();
        failed = false;
      })
      .catch(() => {
        failed = true;
        process.stderr.write("Maintenance dependency or operation failed\n");
      })
      .finally(() => {
        if (!controller.signal.aborted) timer = setTimeout(tick, intervalMs);
      });
  };
  tick();
  const stop = async () => {
    controller.abort();
    if (timer) clearTimeout(timer);
    await active;
    await hook.close?.();
  };
  return Object.assign(stop, {
    readiness: () =>
      !controller.signal.aborted &&
      !failed &&
      completedAt !== undefined &&
      Date.now() - completedAt <= intervalMs + operationMs,
  });
}
