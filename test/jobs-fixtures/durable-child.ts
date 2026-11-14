import { z } from "zod";
import { AccessService } from "../../src/access/service.js";
import { loadConfig } from "../../src/config.js";
import { ConnectionService } from "../../src/connections/service.js";
import { createDatabase } from "../../src/db/database.js";
import { PayloadProcessor } from "../../src/jobs/payloads.js";
import { JobsService } from "../../src/jobs/service.js";
import type { JobDeclaration } from "../../src/jobs/types.js";
import { JobsWorker } from "../../src/jobs/worker.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { requestWorkerTermination, startWorkerHeartbeat } from "../../src/runtime/watchdog.js";
import { SecretBox } from "../../src/security/encryption.js";

const config = loadConfig(process.env);
const db = createDatabase(config);
const controlDb = createDatabase(config, true);
const secrets = new SecretBox(config.ENCRYPTION_ACTIVE_KEY_ID, config.keys);
const access = new AccessService(db, config);
const declaration: JobDeclaration = {
  ref: { id: "trusted-test-job", version: 1 },
  providerRegistrationId: "fixture",
  inputSchema: z.strictObject({ value: z.string() }),
  resultSchema: z.strictObject({ value: z.string() }),
  handler: async (input, context) => {
    const response = await context.request({
      endpoint: "api",
      method: "POST",
      path: "/effect",
      body: JSON.stringify(input),
    });
    await response.text();
    process.send?.({ type: "effect" });
    if ((input as { value: string }).value === "block")
      setTimeout(() => {
        while (true) {}
      }, 100);
    await new Promise(() => {});
    return { kind: "complete", result: input };
  },
};
const provider = {
  id: "fixture",
  revision: 1,
  mode: "personal" as const,
  endpoints: {
    api: {
      baseUrl: process.env.JOB_TEST_UPSTREAM!,
      allowHttp: true,
      privateCidrs: ["127.0.0.1/32"],
    },
  },
  credentialsSchema: z.strictObject({ token: z.string() }),
  contextSchema: z.record(z.string(), z.unknown()),
  attach: () => new Headers(),
  capabilities: [
    {
      ref: declaration.ref,
      providerRegistrationId: "fixture",
      job: { inputSchema: declaration.inputSchema, resultSchema: declaration.resultSchema },
    },
  ],
};
const connections = new ConnectionService(db, access, secrets, new ProviderRegistry([provider]), {
  maxSockets: 4,
  connectTimeoutMs: 500,
  headersTimeoutMs: 500,
  stallTimeoutMs: 1000,
});
const payloads = new PayloadProcessor({
  keyId: config.ENCRYPTION_ACTIVE_KEY_ID,
  keys: config.keys,
  workingBytes: 10000000,
});
const jobs = new JobsService({
  core: { db, controlDb, secrets, access, connections },
  declarations: [declaration],
  payloads,
  callbackOrigin: "http://127.0.0.1:3000",
});
connections.registerAuthority("job", jobs);
connections.registerAuthority("remote-cancel", jobs);
startWorkerHeartbeat(20);
const worker = new JobsWorker(jobs, {
  executionSlots: 2,
  observationSlots: 1,
  leaseMs: 800,
  heartbeatMs: 100,
  scanMs: 200,
  cleanupMs: 300,
  batchSize: 10,
  requestTermination: requestWorkerTermination,
});
await worker.start();
