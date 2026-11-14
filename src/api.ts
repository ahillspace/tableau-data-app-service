import { loadConfig } from "./config.js";
import { assertSchema, createDatabase } from "./db/database.js";
import { createHttpApp } from "./http/app.js";
import { SecretBox } from "./security/encryption.js";

const config = loadConfig(process.env);
const db = createDatabase(config);
new SecretBox(config.ENCRYPTION_ACTIVE_KEY_ID, config.keys);
await assertSchema(db);
const app = await createHttpApp({ db });
app.addHook("onClose", async () => db.destroy());
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  });
}
await app.listen({ host: config.HOST, port: config.PORT });
