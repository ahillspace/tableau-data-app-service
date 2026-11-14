import { createApplication } from "./application.js";
import { readApplicationConfig } from "./application-config.js";
import { loadConfig } from "./config.js";
import { JobsWorker } from "./jobs/worker.js";
import { scheduleMaintenance } from "./runtime/maintenance.js";
import { requestWorkerTermination, startWorkerHeartbeat } from "./runtime/watchdog.js";
import { workerHealth } from "./runtime/worker-health.js";

async function main() {
  const settings = await readApplicationConfig(process.env);
  const stopHeartbeat = startWorkerHeartbeat(settings.worker.heartbeatIntervalMs);
  const config = loadConfig(process.env);
  const application = await createApplication(config, settings, process.env);
  const stopCore = scheduleMaintenance(
    application.maintenance,
    settings.maintenance.scanMs,
    settings.maintenance.operationMs,
  );
  const stopSources = settings.events
    ? scheduleMaintenance(
        application.sourceMaintenance(requestWorkerTermination),
        settings.maintenance.scanMs,
        settings.maintenance.operationMs,
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
  const health = workerHealth(() => ({
    core: !closing && stopCore.readiness(),
    jobs: jobs ? jobs.readiness : "disabled",
    sources: stopSources ? stopSources.readiness() : "disabled",
  }));
  health.on("error", () => requestWorkerTermination("Worker health listener failed"));
  health.listen(config.WORKER_HEALTH_PORT, config.HOST);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      if (closing) return;
      closing = true;
      health.close();
      void Promise.all([jobs?.close(), stopCore(), stopSources?.()])
        .then(() => application.close())
        .catch(() => {
          process.exitCode = 1;
        })
        .finally(stopHeartbeat);
    });
}
void main().catch(() => {
  process.stderr.write("Worker startup failed\n");
  process.exit(1);
});
