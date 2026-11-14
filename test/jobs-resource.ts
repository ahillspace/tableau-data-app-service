// Explicit expensive measurement: npm exec -- tsx test/jobs-resource.ts [inline-baseline]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import canonicalize from "canonicalize";
import { createHttpApp } from "../src/http/app.js";
import { jobsApi } from "../src/jobs/api.js";
import { JobsWorker } from "../src/jobs/worker.js";
import { command, eventually, jobsFixture, workerOptions } from "./jobs-fixture.js";

const f = await jobsFixture();
const worker = new JobsWorker(f.jobs, {
  ...workerOptions,
  leaseMs: 15000,
  heartbeatMs: 1000,
  scanMs: 1000,
  cleanupMs: 5000,
});
const app = await createHttpApp({
  db: f.db,
  core: f.core,
  extensions: [jobsApi(f.jobs, { cleanupMs: 5000 })],
});
const origin = await app.listen({ host: "127.0.0.1", port: 0 });
const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();
let maxRss = process.memoryUsage().rss;
const latencies: number[] = [];
let probing = true;
const probe = (async () => {
  while (probing) {
    const start = performance.now();
    const response = await fetch(`${origin}/health/live`);
    await response.text();
    latencies.push(performance.now() - start);
    maxRss = Math.max(maxRss, process.memoryUsage().rss);
    await new Promise((r) => setTimeout(r, 10));
  }
})();
const times: Record<string, number> = {};
try {
  const size = 100000000;
  const value = { value: "x".repeat(size - Buffer.byteLength(JSON.stringify({ value: "" }))) };
  const raw = command("near-cap", value);
  await new Promise((r) => setTimeout(r, 40));
  latencies.length = 0;
  histogram.reset();
  if (process.argv[2] === "inline-baseline") {
    await new Promise((r) => setTimeout(r, 30));
    const start = performance.now();
    const parsed = JSON.parse(raw.toString());
    f.jobs.options.declarations[0]!.inputSchema.parse(parsed.input);
    const text = canonicalize(parsed.input)!;
    assert.equal(Buffer.byteLength(text), size);
    createHash("sha256")
      .update(canonicalize([1, parsed.capability, { automatic: true }, parsed.input])!)
      .digest("hex");
    const encrypted = f.secrets.seal(Buffer.from(text), {
      kind: "measurement",
      id: "inline",
      revision: "1",
    });
    // Exercise the actual pg driver bytea copies as part of the baseline.
    await f.jobs.db.schema.createTable("measurement").addColumn("bytes", "bytea").execute();
    await import("kysely").then(({ sql }) =>
      sql`insert into measurement values (${Buffer.from(encrypted.ciphertext, "base64url")})`.execute(
        f.jobs.db,
      ),
    );
    times.inlineParseValidateCompareEncryptDbMs = performance.now() - start;
  } else {
    const start = performance.now();
    const response = await fetch(`${origin}/v1/apps/one/jobs`, {
      method: "POST",
      headers: { authorization: `Bearer ${f.alice.token}`, "content-type": "application/json" },
      body: raw,
    });
    assert.equal(
      response.status,
      202,
      await response.text().then((text) => {
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }),
    );
    // Fetch again with a distinct key because the assertion above consumed its body.
    const list = await f.jobs.list(f.alice.access);
    const id = list.items[0]!.id;
    times.admissionMs = performance.now() - start;
    const duplicate = await fetch(`${origin}/v1/apps/one/jobs`, {
      method: "POST",
      headers: { authorization: `Bearer ${f.alice.token}`, "content-type": "application/json" },
      body: raw,
    });
    assert.equal(duplicate.status, 200);
    await duplicate.text();
    times.equalRecoveryMs = performance.now() - start - times.admissionMs;
    const execution = performance.now();
    await worker.start();
    await eventually(
      () => f.jobs.get(f.alice.access, id),
      (j) => j.state === "succeeded",
      60000,
    );
    times.executionAndResultCommitMs = performance.now() - execution;
    const read = performance.now();
    const result = await fetch(`${origin}/v1/apps/one/jobs/${id}/result`, {
      headers: { authorization: `Bearer ${f.alice.token}` },
    });
    assert.equal(result.status, 200);
    const bytes = new Uint8Array(await result.arrayBuffer());
    assert.equal(bytes.byteLength, size);
    times.authorizedResultHttpReadMs = performance.now() - read;
  }
} finally {
  probing = false;
  await probe;
  histogram.disable();
  await worker.close();
  await app.close();
  await f.close();
  latencies.sort((a, b) => a - b);
  const report = {
    mode: process.argv[2] ?? "offloaded-full-http",
    applicationBytes: 100000000,
    times,
    maxRssBytes: maxRss,
    processMaxRssBytes: process.resourceUsage().maxRSS * 1024,
    controlSamples: latencies.length,
    controlP95Ms: latencies[Math.floor(latencies.length * 0.95)],
    controlMaxMs: latencies.at(-1),
    eventLoopMaxMs: histogram.max / 1e6,
    eventLoopP99Ms: histogram.percentile(99) / 1e6,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
