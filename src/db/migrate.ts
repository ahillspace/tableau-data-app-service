import { pathToFileURL } from "node:url";
import { Migrator } from "kysely/migration";
import { loadConfig } from "../config.js";
import { createDatabase, type Database } from "./database.js";
import * as core from "./migrations/001_core.js";
import * as identity from "./migrations/010_identity.js";
import * as authorizations from "./migrations/011_authorizations.js";
import * as configuration from "./migrations/012_configuration.js";
import * as operatorAuthorizations from "./migrations/013_operator_authorizations.js";
import * as jobs from "./migrations/020_jobs.js";
import * as events from "./migrations/030_events.js";

// Module owners add their immutable migration here; API/worker startup never migrates.
export async function migrate(db: Database): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: {
      getMigrations: async () => ({
        "001_core": core,
        "010_identity": identity,
        "011_authorizations": authorizations,
        "012_configuration": configuration,
        "013_operator_authorizations": operatorAuthorizations,
        "020_jobs": jobs,
        "030_events": events,
      }),
    },
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
