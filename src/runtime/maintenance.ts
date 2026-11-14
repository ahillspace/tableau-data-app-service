import type { MaintenanceHook } from "../core-ports.js";

export function scheduleMaintenance(hook: MaintenanceHook, intervalMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  const tick = () => {
    if (controller.signal.aborted) return;
    active = hook
      .run(controller.signal)
      .catch(() => {
        process.stderr.write("Maintenance dependency or operation failed\n");
      })
      .finally(() => {
        if (!controller.signal.aborted) timer = setTimeout(tick, intervalMs);
      });
  };
  tick();
  return async () => {
    controller.abort();
    if (timer) clearTimeout(timer);
    await active;
    await hook.close?.();
  };
}
