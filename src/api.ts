import { createApplication } from "./application.js";
import { readApplicationConfig } from "./application-config.js";
import { loadConfig } from "./config.js";

const config = loadConfig(process.env);
const settings = await readApplicationConfig(process.env);
const application = await createApplication(config, settings, process.env);
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    const timer = setTimeout(() => process.exit(1), settings.worker.terminateGraceMs);
    void application
      .close()
      .catch(() => {
        process.exitCode = 1;
      })
      .finally(() => clearTimeout(timer));
  });
}
await application.app.listen({ host: config.HOST, port: config.PORT });
