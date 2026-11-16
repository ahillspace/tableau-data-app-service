#!/usr/bin/env node
/**
 * Host-local commands, run where the service runs with the service's own settings. These are the
 * only paths that act without an operator session, and each one writes an audit record or report.
 */
import { parseArgs } from "node:util";
import { addOperator } from "../identity/directory.ts";
import { assertSchemaCurrent, openDatabase } from "../persistence/database.ts";
import { ServiceError } from "../platform/errors.ts";
import { loadSettings } from "../platform/settings.ts";
import { reseal } from "../sealing/reseal.ts";
import { Sealer } from "../sealing/sealer.ts";

export const ADMIN_ACTOR = "host-admin";

const USAGE = `Usage:
  tdas-admin operators add --deployment <id> --site <content-url> --user <username>
  tdas-admin reseal`;

type Output = { out(line: string): void; err(line: string): void };
const stdio: Output = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

/** Runs one admin command and returns its exit code. */
export async function admin(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  io: Output = stdio,
): Promise<number> {
  const [group, action] = argv;
  const command = group === "reseal" ? "reseal" : `${group ?? ""} ${action ?? ""}`.trim();
  if (command !== "reseal" && command !== "operators add") {
    io.err(USAGE);
    return 2;
  }
  let flags: {
    deployment?: string | undefined;
    site?: string | undefined;
    user?: string | undefined;
  };
  try {
    flags = parseArgs({
      args: argv.slice(command === "reseal" ? 1 : 2),
      options: {
        deployment: { type: "string" },
        site: { type: "string" },
        user: { type: "string" },
      },
      strict: true,
    }).values;
  } catch (error) {
    io.err(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  try {
    const settings = loadSettings(env);
    const { db } = openDatabase({
      url: settings.databaseUrl,
      caCert: settings.databaseCaCert,
      applicationName: "tdas-admin",
    });
    try {
      await assertSchemaCurrent(db);
      if (command === "reseal") {
        const report = await reseal(db, new Sealer(settings.sealingKeys));
        io.out(JSON.stringify(report));
        return report.remaining === 0 ? 0 : 1;
      }
      const operator = await addOperator(db, ADMIN_ACTOR, {
        deploymentId: flags.deployment ?? "",
        siteContentUrl: flags.site ?? "",
        username: flags.user ?? "",
      });
      io.out(JSON.stringify({ operator }));
      return 0;
    } finally {
      await db.destroy();
    }
  } catch (error) {
    if (error instanceof ServiceError) io.err(JSON.stringify(error.toBody()));
    else
      io.err(
        JSON.stringify({ error: { code: "internal-error", message: (error as Error).message } }),
      );
    return 1;
  }
}

if (import.meta.main) process.exitCode = await admin(process.argv.slice(2));
