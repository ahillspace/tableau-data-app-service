import { pathToFileURL } from "node:url";
import { Migrator } from "kysely/migration";
import { loadConfig } from "../config.js";
import { createDatabase, type Database } from "./database.js";
import * as core from "./migrations/001_core.js";
import * as identity from "./migrations/010_identity.js";

// Module owners add their immutable migration here; API/worker startup never migrates.
export async function migrate(db: Database): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: async () => ({ "001_core": core, "010_identity": identity }) },
  });
  const { error, results } = await migrator.migrateToLatest();
  if (error || results?.some((result) => result.status === "Error"))
    throw new Error("Schema migration failed", { cause: error });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = createDatabase(loadConfig(process.env));
  try {
    await migrate(db);
  } catch {
    process.stderr.write("Schema migration failed\n");
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}
