import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { type TestContext, test } from "node:test";
import { templates } from "../src/catalog/index.ts";
import type { Webhook } from "../src/contracts/operator.ts";
import type { ServiceEvent } from "../src/events/types.ts";
import { type IntakeHarness, IntakeProvider, intakeHarness } from "./support/intake-providers.ts";

const SECRET = "synthetic-inbound-verification-secret";

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(t: TestContext) {
  const provider = await new IntakeProvider().start();
  t.after(() => provider.close());
  const h = await intakeHarness(provider, true);
  t.after(() => h.close());
  const other = await h.replica();
  await until(() => Boolean(h.events?.ready && other.events?.ready), "both Redis replicas");
  return { provider, h, other };
}

/** Read the actual authenticated SSE route on another API replica. */
async function stream(t: TestContext, h: IntakeHarness, origin: string, id: string) {
  const abort = new AbortController();
  const response = await fetch(`${origin}/v1/events/stream?definitions=${id}`, {
    headers: { "Tableau-Service-Authorization": `Bearer ${h.app.bearer}` },
    signal: abort.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const events: ServiceEvent[] = [],
    failures: unknown[] = [];
  let opened = false;
  const pump = (async () => {
    let pending = "";
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        opened = true;
        let end = pending.indexOf("\n\n");
        while (end >= 0) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          if (frame.split("\n").includes("event: event")) {
            const data = frame.split("\n").find((line) => line.startsWith("data: "));
            assert.ok(data);
            events.push(JSON.parse(data.slice(6)));
          }
          end = pending.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) failures.push(error);
    }
  })();
  t.after(async () => {
    abort.abort();
    await reader.cancel().catch(() => {});
    await pump;
  });
  await until(() => opened, "SSE initial frame");
  return { events, failures };
}

function eventConfig(verification: Webhook["verification"]): Webhook {
  return {
    verification,
    event: {
      id: { json: ["id"] },
      type: { json: ["type"] },
      account: [{ json: ["account"] }],
    },
  };
}

function signed(
  kind: "slack" | "github" | "stripe",
  body: Buffer,
  timestamp = String(Math.floor(Date.now() / 1000)),
) {
  const hmac = createHmac("sha256", SECRET);
  if (kind === "slack")
    return {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${hmac.update(`v0:${timestamp}:`).update(body).digest("hex")}`,
    };
  if (kind === "github")
    return { "x-hub-signature-256": `sha256=${hmac.update(body).digest("hex")}` };
  return {
    "stripe-signature": `t=${timestamp},v1=${"0".repeat(64)},v0=ignored,v1=${hmac.update(`${timestamp}.`).update(body).digest("hex")}`,
  };
}

const verifiers: Record<"slack" | "github" | "stripe", Webhook["verification"]> = {
  slack: {
    kind: "hmac",
    algorithm: "sha256",
    header: "X-Slack-Signature",
    prefix: "v0=",
    encoding: "hex",
    timestamp: { header: "X-Slack-Request-Timestamp", toleranceSeconds: 300 },
    parts: [{ literal: "v0:" }, { timestamp: true }, { literal: ":" }, { rawBody: true }],
  },
  github: {
    kind: "hmac",
    algorithm: "sha256",
    header: "X-Hub-Signature-256",
    prefix: "sha256=",
    encoding: "hex",
    parts: [{ rawBody: true }],
  },
  stripe: {
    kind: "compound-hmac",
    algorithm: "sha256",
    header: "Stripe-Signature",
    timestampKey: "t",
    signatureKey: "v1",
    encoding: "hex",
    separator: ".",
    toleranceSeconds: 300,
  },
};

for (const kind of ["slack", "github", "stripe"] as const) {
  test(`${kind} verifies original HTTP bytes and fans out one safe event across real Redis replicas`, {
    timeout: 20_000,
  }, async (t) => {
    const { h, other } = await fixture(t);
    await h.create(
      h.definition(kind, {
        webhook: eventConfig(verifiers[kind]),
        secrets: { signingSecret: SECRET },
      }),
    );
    const received = await stream(t, h, other.origin, kind);
    const body = Buffer.from(
      `{\r\n "id": "${kind}-one", "type":"message", "account":"fixture-account", "text":"snowman ☃ and \\u0061", "token":"synthetic-business-token"\n}\n`,
    );
    const forged = await h.request(`/v1/events/ingest/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...signed(kind, body) },
      body: Buffer.from(JSON.stringify(JSON.parse(body.toString()))),
    });
    assert.equal(forged.status, 401, "reserialization changes the verified bytes");
    if (kind !== "github") {
      for (const offset of [-1000, 1000]) {
        const timestamp = String(Math.floor(Date.now() / 1000) + offset);
        const refused = await h.request(`/v1/events/ingest/${kind}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...signed(kind, body, timestamp) },
          body,
        });
        assert.equal(refused.status, 401);
        assert.equal((await refused.json()).error.code, "event-too-old");
      }
    }
    if (kind === "stripe") {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const header = signed(kind, body, timestamp)["stripe-signature"];
      const ambiguous = await h.request(`/v1/events/ingest/${kind}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": `${header},t=${timestamp}`,
        },
        body,
      });
      assert.equal(ambiguous.status, 401);
    }
    const accepted = await h.request(`/v1/events/ingest/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...signed(kind, body) },
      body,
    });
    assert.equal(accepted.status, 200);
    await until(() => received.events.length === 1, "one verified business event");
    const event = received.events[0];
    assert.ok(event);
    assert.equal(event.id, `${kind}-one`);
    assert.equal(event.type, "message");
    assert.equal(event.account, "fixture-account");
    assert.equal((event.payload as Record<string, unknown>).text, "snowman ☃ and a");
    assert.equal((event.payload as Record<string, unknown>).token, "synthetic-business-token");
    assert.deepEqual(received.failures, []);
    await h.assertSafe([SECRET], [await forged.text(), JSON.stringify(received.events)]);
  });
}

test("verified Slack JSON challenges never fan out, while later business events do", {
  timeout: 20_000,
}, async (t) => {
  const { h, other } = await fixture(t);
  const webhook = eventConfig(verifiers.slack);
  webhook.handshake = {
    kind: "verified-json-echo",
    when: { path: ["type"], equals: "url_verification" },
    value: ["challenge"],
    response: "json",
    responseKey: "challenge",
  };
  await h.create(h.definition("slack-challenge", { webhook, secrets: { signingSecret: SECRET } }));
  const received = await stream(t, h, other.origin, "slack-challenge");
  const challenge = Buffer.from(
    '{ "id":"must-not-publish", "type":"url_verification", "account":"fixture-account", "challenge":"synthetic-challenge" }\n',
  );
  const invalid = await h.request("/v1/events/ingest/slack-challenge", {
    method: "POST",
    headers: { "content-type": "application/json", "x-slack-signature": "v0=invalid" },
    body: challenge,
  });
  assert.equal(invalid.status, 401);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await h.request("/v1/events/ingest/slack-challenge", {
      method: "POST",
      headers: { "content-type": "application/json", ...signed("slack", challenge) },
      body: challenge,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { challenge: "synthetic-challenge" });
  }
  const business = Buffer.from(
    '{"id":"after-challenge","type":"message","account":"fixture-account"}',
  );
  assert.equal(
    (
      await h.request("/v1/events/ingest/slack-challenge", {
        method: "POST",
        headers: { "content-type": "application/json", ...signed("slack", business) },
        body: business,
      })
    ).status,
    200,
  );
  await until(
    () => received.events.some((e) => e.id === "after-challenge"),
    "business event after challenges",
  );
  assert.deepEqual(
    received.events.map((e) => e.id),
    ["after-challenge"],
  );
  await h.assertSafe([SECRET], [JSON.stringify(received.events), await invalid.text()]);
});

test("Graph basic clientState validates entire batches, strips every secret and treats query echo as handshake only", {
  timeout: 20_000,
}, async (t) => {
  const { h, other } = await fixture(t);
  await h.create(
    h.definition("graph", {
      secrets: { signingSecret: SECRET },
      webhook: {
        verification: { kind: "body-secret", batch: ["value"], secret: ["clientState"] },
        handshake: { kind: "query-echo", parameter: "validationToken", response: "text" },
        event: {
          batch: ["value"],
          id: { json: ["id"] },
          type: { json: ["changeType"] },
          account: [{ json: ["tenantId"] }],
          omit: [["internal"]],
        },
      },
    }),
  );
  const received = await stream(t, h, other.origin, "graph");
  const item = (id: string, clientState = SECRET) => ({
    id,
    changeType: "updated",
    tenantId: "synthetic-tenant",
    clientState,
    token: "synthetic-business-token",
    internal: "synthetic-explicitly-omitted",
    resourceData: { id: `resource-${id}` },
  });
  const handshake = await h.request(
    "/v1/events/ingest/graph?validationToken=validation%20%2B%20token%26",
    { method: "POST", json: { value: [item("never-handshake-event")] } },
  );
  assert.equal(handshake.status, 200);
  assert.equal(handshake.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(handshake.headers.get("cache-control"), "no-store");
  assert.equal(handshake.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await handshake.text(), "validation + token&");
  const mixed = await h.request("/v1/events/ingest/graph", {
    method: "POST",
    json: {
      value: [
        item("must-not-partially-publish"),
        item("wrong-secret", "synthetic-wrong-client-state"),
      ],
    },
  });
  assert.equal(mixed.status, 401);
  const excessive = await h.request("/v1/events/ingest/graph", {
    method: "POST",
    json: { value: Array.from({ length: 1001 }, (_, index) => item(`excess-${index}`)) },
  });
  assert.equal(excessive.status, 400);
  const normal = await h.request("/v1/events/ingest/graph", {
    method: "POST",
    json: { value: [item("one"), item("two")] },
  });
  assert.equal(normal.status, 200);
  await until(() => received.events.length === 2, "both Graph events");
  assert.deepEqual(
    received.events.map((e) => e.id),
    ["one", "two"],
  );
  for (const event of received.events) {
    assert.equal(event.type, "updated");
    assert.equal(event.account, "synthetic-tenant");
    assert.equal("clientState" in (event.payload as Record<string, unknown>), false);
    assert.equal("internal" in (event.payload as Record<string, unknown>), false);
    assert.equal((event.payload as Record<string, unknown>).token, "synthetic-business-token");
    assert.deepEqual((event.payload as Record<string, unknown>).resourceData, {
      id: `resource-${event.id}`,
    });
  }
  assert.deepEqual(received.failures, []);
  await h.assertSafe(
    [SECRET, "synthetic-wrong-client-state", "synthetic-explicitly-omitted"],
    [await mixed.text(), await excessive.text(), JSON.stringify(received.events)],
  );
});

test("a missing webhook secret refuses business ingress without blocking native credentials", {
  timeout: 20_000,
}, async (t) => {
  const { provider, h } = await fixture(t);
  const view = await h.create(
    h.definition("native-independent", {
      authentication: { method: "static" },
      credential: { kind: "token", value: "synthetic-native-credential" },
      webhook: eventConfig(verifiers.github),
    }),
  );
  assert.equal(view.setup.state, "ready");
  assert.deepEqual(view.setup.missing, []);
  provider.expect("/native", (r) =>
    assert.ok(r.headers.authorization === "Bearer synthetic-native-credential"),
  );
  assert.equal((await h.native("native-independent")).status, 200);
  const response = await h.request("/v1/events/ingest/native-independent", {
    method: "POST",
    json: { id: "missing-secret", type: "message", account: "fixture" },
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "events-not-configured");
  provider.assertComplete();
});

for (const id of ["slack-bot", "slack-user"]) {
  test(`${id} catalog map omits only the configured envelope token during real ingress`, {
    timeout: 20_000,
  }, async (t) => {
    const { h, other } = await fixture(t);
    const template = templates.find((entry) => entry.id === id);
    assert.ok(template?.definition.webhook);
    const definitionId = `catalog-${id}`;
    await h.create(
      h.definition(definitionId, {
        webhook: template.definition.webhook,
        secrets: { signingSecret: SECRET },
      }),
    );
    const received = await stream(t, h, other.origin, definitionId);
    const body = Buffer.from(
      JSON.stringify({
        type: "event_callback",
        event_id: definitionId,
        team_id: "fixture-team",
        token: "synthetic-legacy-envelope",
        event: { type: "message", token: "synthetic-nested-business-token" },
      }),
    );
    const accepted = await h.request(`/v1/events/ingest/${definitionId}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...signed("slack", body) },
      body,
    });
    assert.equal(accepted.status, 200);
    await until(() => received.events.length === 1, "catalog-configured Slack event");
    const payload = received.events[0]!.payload as Record<string, unknown>;
    assert.equal(Object.hasOwn(payload, "token"), false);
    assert.equal(
      (payload.event as Record<string, unknown>).token,
      "synthetic-nested-business-token",
    );
    await h.assertSafe([SECRET, "synthetic-legacy-envelope"], [JSON.stringify(received.events)]);
  });
}
