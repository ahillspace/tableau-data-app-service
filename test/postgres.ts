import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { initdb, pg_ctl } from "@embedded-postgres/linux-x64";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db/database.js";
import { migrate } from "../src/db/migrate.js";

const execute = promisify(execFile);
export async function testPostgres() {
  const directory = await mkdtemp(join(tmpdir(), "tableau-service-pg-"));
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("Cannot allocate test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  await execute(
    initdb,
    ["-D", join(directory, "data"), "-A", "trust", "-U", "test", "--no-locale", "--encoding=UTF8"],
    { timeout: 30000 },
  );
  let started = false;
  try {
    await execute(
      pg_ctl,
      [
        "-D",
        join(directory, "data"),
        "-l",
        join(directory, "postgres.log"),
        "-o",
        `-h 127.0.0.1 -p ${port} -k ${directory} -F`,
        "-w",
        "start",
      ],
      { timeout: 30000 },
    );
    started = true;
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: `postgresql://test@127.0.0.1:${port}/postgres`,
      SERVICE_ORIGIN: "http://127.0.0.1:3000",
      ENCRYPTION_ACTIVE_KEY_ID: "test",
      ENCRYPTION_KEYS: JSON.stringify({ test: "01".repeat(32) }),
    });
    const db = createDatabase(config);
    await migrate(db);
    return {
      db,
      config,
      async close() {
        await db.destroy();
        await execute(pg_ctl, ["-D", join(directory, "data"), "-m", "immediate", "-w", "stop"], {
          timeout: 30000,
        });
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (started)
      await execute(pg_ctl, ["-D", join(directory, "data"), "-m", "immediate", "-w", "stop"], {
        timeout: 30000,
      });
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
