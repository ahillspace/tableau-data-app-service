import { z } from "zod";
import { ConnectionService } from "../src/connections/service.js";
import { createDatabase } from "../src/db/database.js";
import { up } from "../src/db/migrations/020_jobs.js";
import { PayloadProcessor } from "../src/jobs/payloads.js";
import { JobsService } from "../src/jobs/service.js";
import type { JobDeclaration } from "../src/jobs/types.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { candidate, coreFixture, fixtureProvider } from "./core-fixture.js";
export const jobDeclaration: JobDeclaration = {
  ref: { id: "trusted-test-job", version: 1 },
  providerRegistrationId: "fixture",
  inputSchema: z.strictObject({ value: z.string().default("default") }),
  resultSchema: z.strictObject({ value: z.string() }),
  handler: async (input) => ({ kind: "complete", result: input }),
};
export const workerOptions = {
  executionSlots: 1,
  observationSlots: 1,
  leaseMs: 3000,
  heartbeatMs: 100,
  scanMs: 200,
  cleanupMs: 1000,
  batchSize: 20,
  requestTermination: () => {
    throw new Error("Unexpected process termination request");
  },
};
export async function jobsFixture(declarations: readonly JobDeclaration[] = [jobDeclaration]) {
  const f = await coreFixture();
  const data2 = createDatabase(f.config);
  const control = createDatabase(f.config, true);
  const control2 = createDatabase(f.config, true);
  const payloads = new PayloadProcessor({
    keyId: f.config.ENCRYPTION_ACTIVE_KEY_ID,
    keys: f.config.keys,
    workingBytes: 2200000000,
  });
  try {
    await up(f.db as unknown as import("kysely").Kysely<unknown>);
    const provider = {
      ...fixtureProvider,
      capabilities: declarations.map((d) => ({
        ref: d.ref,
        providerRegistrationId: d.providerRegistrationId,
        job: { inputSchema: d.inputSchema, resultSchema: d.resultSchema },
      })),
    };
    const providers = new ProviderRegistry([provider]);
    const connections = new ConnectionService(f.db, f.access, f.secrets, providers, {
      maxSockets: 4,
      connectTimeoutMs: 1000,
      headersTimeoutMs: 1000,
      stallTimeoutMs: 1000,
    });
    const connection = await f.credentials.publishLocal(f.alice.access, provider, candidate());
    const core = {
      db: f.db,
      controlDb: control,
      secrets: f.secrets,
      access: f.access,
      connections,
    };
    const jobs = new JobsService({
      core,
      declarations,
      payloads,
      callbackOrigin: "http://127.0.0.1:3000",
    });
    const jobs2 = new JobsService({
      core: { ...core, db: data2, controlDb: control2 },
      declarations,
      payloads,
      callbackOrigin: "http://127.0.0.1:3000",
    });
    connections.registerAuthority("job", jobs);
    connections.registerAuthority("remote-cancel", jobs);
    return {
      ...f,
      provider,
      providers,
      core,
      connections,
      connection,
      jobs,
      jobs2,
      control,
      payloads,
      async close() {
        await payloads.close();
        await control.destroy();
        await control2.destroy();
        await data2.destroy();
        await f.close();
      },
    };
  } catch (error) {
    await payloads.close();
    await control.destroy();
    await control2.destroy();
    await data2.destroy();
    await f.close();
    throw error;
  }
}
export const command = (
  submissionId: string,
  input: unknown = { value: "hello" },
  connectionId?: string,
) =>
  Buffer.from(
    JSON.stringify({
      submissionId,
      capability: jobDeclaration.ref,
      input,
      ...(connectionId ? { connectionId } : {}),
    }),
  );
export async function eventually<T>(
  run: () => Promise<T>,
  accept: (value: T) => boolean,
  ms = 5000,
): Promise<T> {
  const until = Date.now() + ms;
  let value: T;
  do {
    value = await run();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < until);
  throw new Error(`Expected condition did not settle within ${ms}ms`);
}
