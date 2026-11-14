import { applyConfiguration, readApplicationConfig } from "./application-config.js";
import { loadConfig } from "./config.js";
import { assertSchema, createDatabase, type Database } from "./db/database.js";

let db: Database | undefined;
try {
  db = createDatabase(loadConfig(process.env));
  await assertSchema(db);
  await applyConfiguration(db, await readApplicationConfig(process.env));
  process.stdout.write("Configuration applied\n");
} catch {
  process.stderr.write("Configuration apply failed\n");
  process.exitCode = 1;
} finally {
  await db?.destroy();
}
