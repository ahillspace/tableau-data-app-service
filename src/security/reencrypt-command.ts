import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { assertSchema, createDatabase, type Database } from "../db/database.js";
import { SecretBox } from "./encryption.js";
import { reencryptProtectedRecords } from "./records.js";

let db: Database | undefined;
try {
  const { values } = parseArgs({
    options: {
      from: { type: "string" },
      to: { type: "string" },
      "writers-stopped": { type: "boolean" },
      "working-bytes": { type: "string" },
    },
    strict: true,
  });
  if (!values.from || !values.to || !values["working-bytes"])
    throw new Error("Required offline maintenance arguments are missing");
  const config = loadConfig(process.env);
  db = createDatabase(config);
  await assertSchema(db);
  const result = await reencryptProtectedRecords(
    db,
    new SecretBox(config.ENCRYPTION_ACTIVE_KEY_ID, config.keys),
    {
      from: values.from,
      to: values.to,
      workingBytes: Number(values["working-bytes"]),
      writersStopped: values["writers-stopped"] === true,
    },
  );
  process.stdout.write(
    `Verified ${result.verified} protected records; converted ${result.changed}\n`,
  );
} catch {
  process.stderr.write(
    "Offline re-encryption failed; keep writers stopped and preserve old/new keys and evidence\n",
  );
  process.exitCode = 1;
} finally {
  await db?.destroy();
}
