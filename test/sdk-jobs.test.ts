import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventsExtension } from "../src/events/index.js";
import { createHttpApp } from "../src/http/app.js";
import { registerCoreRoutes } from "../src/http/core-routes.js";
import { jobsApi } from "../src/jobs/api.js";
import { JobsService } from "../src/jobs/service.js";
import { JobsWorker } from "../src/jobs/worker.js";
import { type LiveNotification, ServiceClient } from "../src/sdk/index.js";
import { testRedis, eventually as waitFor } from "./events-runtime.js";
import { eventually, jobDeclaration, jobsFixture, workerOptions } from "./jobs-fixture.js";

test("public SDK submits, browses opaque pages, cancels and consumes direct results through actual Jobs HTTP and lossy Redis hints", async () => {
  const redis = await testRedis();
  const f = await jobsFixture();
  const payloadBytes = 12345;
  const jobs = new JobsService({
    ...f.jobs.options,
    onHint: (id, revision) => {
      void events.publishJobHint(id, revision);
    },
  });
  const events = createEventsExtension({
    enabled: true,
    redis: {
      publishUrl: redis.url,
      subscribeUrl: redis.url,
      channelScope: "sdk-jobs",
      commandTimeoutMs: 300,
    },
    limits: {
      payloadBytes,
      maxAgeMs: 30000,
      clockSkewMs: 1000,
      publisherBytes: 131072,
      subscriberBytes: 131072,
      streamBytes: 65536,
      aggregateBytes: 262144,
      stallMs: 1000,
      heartbeatMs: 100,
    },
    providers: new Map(),
    discloseJob: (access, id) => jobs.disclose(access, id),
  });
  const worker = new JobsWorker(jobs, workerOptions);
  const app = await createHttpApp({
    db: f.db,
    core: f.core,
    extensions: [jobsApi(jobs, { cleanupMs: 1000 }), events],
  });
  registerCoreRoutes(app, {
    access: f.access,
    credentials: f.credentials,
    connections: f.connections,
    providers: f.providers,
    corsOrigins: [],
    jsonPreparationBytes: 65536,
    eventPayloadBytes: payloadBytes,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new ServiceClient({
    serviceOrigin: app.listeningOrigin,
    appId: "one",
    deploymentId: "cloud",
  });
  const otherOwner = new ServiceClient({
    serviceOrigin: app.listeningOrigin,
    appId: "two",
    deploymentId: "cloud",
  });
  // The core fixture supplies independently authenticated principals; browser restoration has its own actual-browser proof.
  client.http.setBearer(f.alice.token);
  otherOwner.http.setBearer(f.bob.token);
  const seen: LiveNotification[] = [],
    hidden: LiveNotification[] = [];
  const controller = new AbortController();
  let subscription: Promise<void> | undefined, otherSubscription: Promise<void> | undefined;
  try {
    const discovery = await client.discover();
    await otherOwner.discover();
    assert.equal(discovery.events?.payloadBytes, payloadBytes);
    await waitFor(async () => (await events.health()) === "ready");
    subscription = client.subscribe(
      (event) => {
        seen.push(event);
      },
      { signal: controller.signal },
    );
    otherSubscription = otherOwner.subscribe(
      (event) => {
        hidden.push(event);
      },
      { signal: controller.signal },
    );
    await waitFor(
      () =>
        seen.some((event) => event.kind === "resync-required") &&
        hidden.some((event) => event.kind === "resync-required"),
    );
    const submission = client.jobs.submission({
      capability: jobDeclaration.ref,
      input: { value: "direct result" },
    });
    const first = await client.jobs.submit(submission);
    assert.equal((await client.jobs.submit(submission)).id, first.id);
    const second = await client.jobs.submit(
      client.jobs.submission({ capability: jobDeclaration.ref, input: { value: "cancel me" } }),
    );
    const page = await client.jobs.list({
      appId: "one",
      capability: jobDeclaration.ref.id,
      limit: 1,
    });
    assert.equal(page.items.length, 1);
    assert.ok(page.next);
    const next = await client.jobs.list({
      appId: "one",
      capability: jobDeclaration.ref.id,
      limit: 1,
      next: page.next,
    });
    assert.deepEqual([page.items[0]!.id, next.items[0]!.id], [first.id, second.id]);
    assert.equal(next.next, undefined);
    const notReady = await client.jobs.result(first.id);
    assert.equal(notReady.status, 409);
    await notReady.body?.cancel();
    assert.equal((await client.jobs.cancel(second.id)).state, "cancelled");
    await worker.start();
    await eventually(
      () => client.jobs.get(first.id),
      (job) => job.state === "succeeded",
    );
    const result = await client.jobs.result(first.id);
    assert.match(result.headers.get("content-type")!, /^application\/json(?:;|$)/);
    assert.deepEqual(await result.json(), { value: "direct result" });
    await waitFor(() =>
      seen.some((event) => event.kind === "job-hint" && event.jobId === first.id),
    );
    assert.equal(
      hidden.some((event) => event.kind === "job-hint"),
      false,
    );
    assert.deepEqual((await otherOwner.jobs.list()).items, []);
    const denied = await otherOwner.jobs.result(first.id);
    assert.equal(denied.status, 404);
    await denied.body?.cancel();
  } finally {
    controller.abort();
    await subscription;
    await otherSubscription;
    client.close();
    otherOwner.close();
    await worker.close();
    await app.close();
    await f.close();
    await redis.close();
  }
});
