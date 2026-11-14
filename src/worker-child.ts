import { createApplication } from "./application.js";
import { readApplicationConfig } from "./application-config.js";
import { loadConfig } from "./config.js";
import { JobsWorker } from "./jobs/worker.js";
import { scheduleMaintenance } from "./runtime/maintenance.js";
import { requestWorkerTermination, startWorkerHeartbeat } from "./runtime/watchdog.js";

const settings = await readApplicationConfig(process.env);
const stopHeartbeat = startWorkerHeartbeat(settings.worker.heartbeatIntervalMs);
const application = await createApplication(loadConfig(process.env), settings, process.env);
const stopCore = scheduleMaintenance(application.maintenance, settings.maintenance.scanMs);
const stopSources = settings.events
  ? scheduleMaintenance(
      application.sourceMaintenance(requestWorkerTermination),
      settings.maintenance.scanMs,
    )
  : undefined;
const jobs = application.jobs
  ? new JobsWorker(application.jobs, {
      ...settings.worker,
      cleanupMs: settings.maintenance.cleanupMs,
      requestTermination: requestWorkerTermination,
    })
  : undefined;
await jobs?.start();
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    void Promise.all([jobs?.close(), stopCore(), stopSources?.()])
      .then(() => application.close())
      .catch(() => {
        process.exitCode = 1;
      })
      .finally(stopHeartbeat);
  });
