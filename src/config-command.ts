import { applyConfiguration, readApplicationConfig } from "./application-config.js";
import { loadConfig } from "./config.js";
import { assertSchema, createDatabase } from "./db/database.js";

const db = createDatabase(loadConfig(process.env));
try {
  await assertSchema(db);
  await applyConfiguration(db, await readApplicationConfig(process.env));
  process.stdout.write("Configuration applied\n");
} catch {
  process.stderr.write("Configuration apply failed\n");
  process.exitCode = 1;
} finally {
  await db.destroy();
}
