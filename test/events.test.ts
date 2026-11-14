import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { connect } from "node:net";
import { test } from "node:test";
import { ConnectionService } from "../src/connections/service.js";
import type { CoreServices } from "../src/core-ports.js";
import { createEventsExtension } from "../src/events/index.js";
import { decodeEnvelope, type EventLimits, eventBudgets } from "../src/events/protocol.js";
import { slackEventProvider } from "../src/events/slack.js";
import { createHttpApp } from "../src/http/app.js";
import { registerCoreRoutes } from "../src/http/core-routes.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { type LiveNotification, ServiceClient } from "../src/sdk/index.js";
import { candidate, coreFixture, fixtureProvider } from "./core-fixture.js";
import { eventually, testRedis } from "./events-runtime.js";

const limits: EventLimits = {
  payloadBytes: 16384,
  maxAgeMs: 30000,
  clockSkewMs: 1000,
  publisherBytes: 131072,
  subscriberBytes: 131072,
  streamBytes: 65536,
  aggregateBytes: 262144,
  stallMs: 500,
  heartbeatMs: 100,
};
const signingSecret = "test-only-signature-key";

test("disabled Events needs no Redis configuration or schema and leaves core readiness available", async () => {
  const f = await coreFixture();
  const connections = new ConnectionService(
    f.db,
    f.access,
    f.secrets,
    new ProviderRegistry([fixtureProvider]),
    { connectTimeoutMs: 1000, headersTimeoutMs: 1000, stallTimeoutMs: 1000, maxSockets: 8 },
  );
  const extension = createEventsExtension({ enabled: false });
  const app = await createHttpApp({
    db: f.db,
    core: { db: f.db, controlDb: f.db, secrets: f.secrets, access: f.access, connections },
    extensions: [extension],
  });
  try {
    const readiness = await app.inject({ method: "GET", url: "/health/ready" });
    assert.equal(readiness.statusCode, 200);
    assert.deepEqual(readiness.json(), { core: "ready", events: ["disabled"] });
    const unavailable = await app.inject({ method: "GET", url: "/v1/apps/one/events" });
    assert.equal(unavailable.statusCode, 503);
    assert.equal(unavailable.json().error.code, "events-disabled");
  } finally {
    await app.close();
    await f.close();
  }
});
function signature(raw: string, timestamp = String(Math.floor(Date.now() / 1000))) {
  return {
    "content-type": "application/json",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${raw}`).digest("hex")}`,
  };
}
async function fixture(redisUrl: string, profile = limits) {
  const f = await coreFixture();
  const connections = new ConnectionService(
    f.db,
    f.access,
    f.secrets,
    new ProviderRegistry([fixtureProvider]),
    { connectTimeoutMs: 1000, headersTimeoutMs: 1000, stallTimeoutMs: 1000, maxSockets: 8 },
  );
  const core: CoreServices = {
    db: f.db,
    controlDb: f.db,
    secrets: f.secrets,
    access: f.access,
    connections,
  };
  const provider = slackEventProvider(async (_input, context) =>
    context.withCredentials(async () => ({
      accountKey: "fixture-account",
      privateContext: { signingSecret, teamId: "T1", appId: "A1" },
      expiresAt: new Date(Date.now() - 1000),
    })),
  );
  const extension = createEventsExtension({
    enabled: true,
    redis: {
      publishUrl: redisUrl,
      subscribeUrl: redisUrl,
      channelScope: "test",
      commandTimeoutMs: 300,
    },
    limits: profile,
    providers: new Map([["fixture", provider]]),
  });
  const app = await createHttpApp({ db: f.db, core, extensions: [extension] });
  registerCoreRoutes(app, {
    access: f.access,
    credentials: f.credentials,
    connections,
    providers: new ProviderRegistry([fixtureProvider]),
    corsOrigins: [],
    jsonPreparationBytes: 65536,
    eventPayloadBytes: profile.payloadBytes,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP test port");
  const origin = `http://127.0.0.1:${address.port}`;
  const connection = await f.credentials.publishLocal(f.alice.access, fixtureProvider, candidate());
  connections.registerAuthority("event-source", extension.sources!.backgroundAuthority());
  const sourceId = await extension.sources!.associate(f.alice.access, {
    providerRegistrationId: "fixture",
    connectionId: connection.id,
    setup: "manual",
    inputs: {},
  });
  return {
    ...f,
    app,
    origin,
    extension,
    sourceId,
    connection,
    async close() {
      await app.close();
      await f.close();
    },
  };
}
function listen(origin: string, token: string, app = "one") {
  const controller = new AbortController();
  const events: string[] = [];
  const opened = fetch(`${origin}/v1/apps/${app}/events`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  }).then((response) => {
    assert.equal(response.status, 200);
    return response;
  });
  const finished = opened
    .then(async (response) => {
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        let separator: number;
        while ((separator = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          if (frame.startsWith("event:")) events.push(frame);
        }
      }
    })
    .catch(() => {});
  return {
    opened,
    events,
    async close() {
      controller.abort();
      await finished;
    },
  };
}

test("real Redis/HTTP events verify exact signatures and account, preserve native data, and recheck current owner/source authority", async () => {
  const redis = await testRedis();
  const f = await fixture(redis.url);
  try {
    await eventually(async () => (await f.extension.health()) === "ready");
    const a = listen(f.origin, f.alice.token, "two"),
      b = listen(f.origin, f.bob.token);
    try {
      await Promise.all([a.opened, b.opened]);
      const raw = JSON.stringify({
        type: "event_callback",
        team_id: "T1",
        api_app_id: "A1",
        event_id: "event-1",
        token: "legacy-never-forward",
        event: { type: "message", text: "native transient detail" },
      });
      const send = (body: string, headers = signature(body)) =>
        fetch(`${f.origin}/v1/providers/fixture/events/${f.sourceId}`, {
          method: "POST",
          headers,
          body,
        });
      assert.equal((await send(`${raw} `, signature(raw))).status, 403);
      assert.equal(
        (await send(raw, signature(raw, String(Math.floor(Date.now() / 1000) - 301)))).status,
        403,
      );
      const wrong = raw.replace('"T1"', '"OTHER"');
      assert.equal((await send(wrong)).status, 403);
      const challenge = JSON.stringify({
        type: "url_verification",
        challenge: "verified-challenge",
      });
      assert.equal(await (await send(challenge)).text(), "verified-challenge");
      assert.equal((await send(raw)).status, 200);
      await eventually(() => a.events.some((event) => event.includes('"id":"event-1"')));
      const publicData = JSON.parse(
        a.events.find((event) => event.includes('"id":"event-1"'))!.split("\ndata: ")[1]!,
      );
      assert.deepEqual(JSON.parse(Buffer.from(publicData.payload, "base64url").toString()), {
        type: "message",
        text: "native transient detail",
      });
      assert.equal(
        b.events.some((event) => event.includes("event-1")),
        false,
      );
      // Subscription expiry is health only for this verifier; the signed delayed event was still accepted.
      await f.extension.sources!.retire(f.alice.access, f.sourceId);
      assert.equal((await send(raw)).status, 404);
      await f.db
        .updateTable("tableau_sites")
        .set({ enabled: false })
        .where("id", "=", "site-row")
        .execute();
      await eventually(() => a.events.filter((event) => event.includes("provider")).length === 1);
      assert.equal(
        (
          await fetch(`${f.origin}/v1/apps/one/events`, {
            headers: { authorization: `Bearer ${f.alice.token}` },
          })
        ).status,
        401,
      );
    } finally {
      await a.close();
      await b.close();
    }
  } finally {
    await f.close();
    await redis.close();
  }
});

test("Redis outage degrades Events alone; reconnect resubscribes and signals loss without replaying accepted payloads", async () => {
  const redis = await testRedis();
  const f = await fixture(redis.url);
  let stream: ReturnType<typeof listen> | undefined;
  try {
    await eventually(async () => (await f.extension.health()) === "ready");
    stream = listen(f.origin, f.alice.token);
    await stream.opened;
    const before = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      api_app_id: "A1",
      event_id: "before-outage",
      event: { type: "message", text: "before" },
    });
    const send = (body: string) =>
      fetch(`${f.origin}/v1/providers/fixture/events/${f.sourceId}`, {
        method: "POST",
        headers: signature(body),
        body,
      });
    assert.equal((await send(before)).status, 200);
    await eventually(() => stream!.events.some((event) => event.includes("before-outage")));
    await redis.stop();
    await eventually(async () => (await f.extension.health()) === "degraded");
    assert.equal((await fetch(`${f.origin}/health/ready`)).status, 200);
    assert.equal((await send(before)).status, 503);
    assert.equal(
      (
        await fetch(`${f.origin}/v1/apps/one/events`, {
          headers: { authorization: `Bearer ${f.alice.token}` },
        })
      ).status,
      503,
    );
    await stream.close();
    await redis.start();
    await eventually(async () => (await f.extension.health()) === "ready", 5000);
    stream = listen(f.origin, f.alice.token);
    await stream.opened;
    await eventually(() => stream!.events.some((event) => event.includes("resync-required")));
    const after = before.replaceAll("before-outage", "after-outage");
    assert.equal((await send(after)).status, 200);
    await eventually(() => stream!.events.some((event) => event.includes("after-outage")));
    assert.equal(
      stream.events.some((event) => event.includes("before-outage")),
      false,
    );
  } finally {
    await stream?.close();
    await f.close();
    await redis.close();
  }
});

test("one payload cap fits envelopes; invalid encodings, oversized payloads and incompatible physical budgets fail", () => {
  assert.throws(() => eventBudgets({ ...limits, streamBytes: limits.payloadBytes }));
  const event = {
    version: 1,
    kind: "provider",
    eventId: "e",
    sourceId: "s",
    sourceRevision: 1,
    ingressAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1000).toISOString(),
    validUntil: new Date(Date.now() + 1000).toISOString(),
    type: "native",
    payloadEncoding: "base64url",
    payloadMediaType: "application/octet-stream",
    payload: Buffer.alloc(limits.payloadBytes).toString("base64url"),
  };
  assert.equal(decodeEnvelope(JSON.stringify(event), limits).kind, "provider");
  assert.throws(() =>
    decodeEnvelope(JSON.stringify({ ...event, payload: `${event.payload}A` }), limits),
  );
  assert.throws(() => decodeEnvelope(JSON.stringify({ ...event, payload: "AA==" }), limits));
});

test("maximum native payload survives real Redis/SSE; shared audience revocation applies to the next event without relying on Redis invalidation", async () => {
  const redis = await testRedis();
  const f = await fixture(redis.url);
  let a: ReturnType<typeof listen> | undefined, b: ReturnType<typeof listen> | undefined;
  const client = new ServiceClient({
    serviceOrigin: f.origin,
    appId: "one",
    deploymentId: "cloud",
  });
  client.http.setBearer(f.alice.token);
  const received: LiveNotification[] = [];
  const controller = new AbortController();
  let sdkStream: Promise<void> | undefined;
  try {
    await eventually(async () => (await f.extension.health()) === "ready");
    await f.extension.sources!.associateOperator({
      id: "shared",
      providerRegistrationId: "fixture",
      appId: "one",
      setupOwnerId: f.alice.access.ownerId,
      setup: "manual",
      publication: {
        accountKey: "fixture-account",
        privateContext: { signingSecret, teamId: "T1", appId: "A1" },
      },
      audience: [{ deploymentId: "cloud", siteId: "site", subjectId: "alice" }],
    });
    a = listen(f.origin, f.alice.token);
    b = listen(f.origin, f.bob.token);
    await Promise.all([a.opened, b.opened]);
    assert.equal((await client.discover()).events?.payloadBytes, limits.payloadBytes);
    sdkStream = client.subscribe(
      (event) => {
        received.push(event);
      },
      { signal: controller.signal },
    );
    await eventually(() => received.some((event) => event.kind === "resync-required"));
    const empty = { type: "message", text: "" };
    const native = {
      ...empty,
      text: "x".repeat(limits.payloadBytes - Buffer.byteLength(JSON.stringify(empty))),
    };
    const send = (id: string, event: unknown) => {
      const body = JSON.stringify({
        type: "event_callback",
        team_id: "T1",
        api_app_id: "A1",
        event_id: id,
        event,
      });
      return fetch(`${f.origin}/v1/providers/fixture/events/shared`, {
        method: "POST",
        headers: signature(body),
        body,
      });
    };
    assert.equal((await send("maximum", native)).status, 200);
    await eventually(() => a!.events.some((event) => event.includes('"id":"maximum"')));
    const delivered = JSON.parse(
      a.events.find((event) => event.includes('"id":"maximum"'))!.split("\ndata: ")[1]!,
    );
    assert.equal(Buffer.from(delivered.payload, "base64url").byteLength, limits.payloadBytes);
    await eventually(() =>
      received.some((event) => event.kind === "provider" && event.id === "maximum"),
    );
    const sdkNative = received.find((event) => event.kind === "provider" && event.id === "maximum");
    assert.ok(sdkNative?.kind === "provider");
    assert.deepEqual(sdkNative.data, native);
    assert.equal((await send("oversized", { ...native, text: `${native.text}x` })).status, 413);
    assert.equal(
      b.events.some((event) => event.includes('"id":"maximum"')),
      false,
    );
    const db = f.extension.sources!.db;
    await db.deleteFrom("event_source_audience").where("source_id", "=", "shared").execute();
    await db
      .insertInto("event_source_audience")
      .values({ source_id: "shared", deployment_id: "cloud", site_id: "site", subject_id: "bob" })
      .execute();
    assert.equal(
      (await send("after-revoke", { type: "message", text: "private for current audience" }))
        .status,
      200,
    );
    await eventually(() => b!.events.some((event) => event.includes('"id":"after-revoke"')));
    assert.equal(
      a.events.some((event) => event.includes('"id":"after-revoke"')),
      false,
    );
  } finally {
    controller.abort();
    await sdkStream;
    client.close();
    await a?.close();
    await b?.close();
    await f.close();
    await redis.close();
  }
});

test("a real non-reading SSE socket is dropped within its queue/stall budget while another browser keeps receiving and ingress stays independent", async () => {
  const redis = await testRedis();
  const profile = {
    ...limits,
    payloadBytes: 262144,
    publisherBytes: 4194304,
    subscriberBytes: 4194304,
    streamBytes: 1048576,
    aggregateBytes: 8388608,
    stallMs: 200,
  };
  const f = await fixture(redis.url, profile);
  let fast: ReturnType<typeof listen> | undefined;
  const url = new URL(f.origin),
    slow = connect(Number(url.port), "127.0.0.1");
  slow.on("error", () => {});
  slow.pause();
  let closed = false;
  slow.on("close", () => {
    closed = true;
  });
  try {
    await eventually(async () => (await f.extension.health()) === "ready");
    slow.write(
      `GET /v1/apps/one/events HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${f.alice.token}\r\n\r\n`,
    );
    fast = listen(f.origin, f.alice.token);
    await fast.opened;
    const native = { type: "message", text: "x".repeat(profile.payloadBytes - 100) };
    let last = "";
    for (let i = 0; i < 100; i++) {
      last = `large-${i}`;
      const body = JSON.stringify({
        type: "event_callback",
        team_id: "T1",
        api_app_id: "A1",
        event_id: last,
        event: native,
      });
      const response = await fetch(`${f.origin}/v1/providers/fixture/events/${f.sourceId}`, {
        method: "POST",
        headers: signature(body),
        body,
      });
      assert.equal(response.status, 200);
      await response.body?.cancel();
    }
    await eventually(() => fast!.events.some((event) => event.includes(`"id":"${last}"`)), 5000);
    assert.ok(f.extension.diagnostics().streams!.slow >= 1);
    slow.resume();
    await eventually(() => closed, 5000);
    assert.equal((await fetch(`${f.origin}/health/ready`)).status, 200);
  } finally {
    slow.destroy();
    await fast?.close();
    await f.close();
    await redis.close();
  }
});
