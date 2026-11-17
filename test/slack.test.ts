import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { templates } from "../src/catalog/index.ts";
import { readTokens } from "../src/connections/protocol.ts";
import type { ConnectionDefinition } from "../src/connections/types.ts";
import { validateDefinition } from "../src/connections/validation.ts";
import { verifyDelivery } from "../src/events/verification.ts";
import { destination } from "../src/router/router.ts";

function slack(mode: "bot" | "user"): ConnectionDefinition {
  const input = structuredClone(templates.find((t) => t.id === `slack-${mode}`)?.definition);
  assert.ok(input?.authentication?.method === "authorization_code");
  input.authentication.clientAuthentication = {
    method: "client_secret_basic",
    clientId: "synthetic-client",
  };
  const parsed = validateDefinition(
    { ...input, id: `slack-${mode}`, audience: [] },
    { siteIds: new Set() },
  );
  assert.deepEqual(parsed.errors, []);
  return { ...parsed.definition, generation: 1, version: 1, secretGeneration: 1, retired: false };
}
const now = new Date();
test("Slack templates retain both hosts and reject an external file host", () => {
  const d = slack("bot");
  assert.deepEqual(d.apiHosts, ["https://slack.com/api", "https://files.slack.com"]);
  assert.equal(
    destination(d, "/files-pri/T/file", "https://files.slack.com").url.host,
    "files.slack.com",
  );
  assert.throws(() => destination(d, "/file", "https://external.example"));
});
test("Slack bot and user initial mappings, independent user refresh and enterprise fallback are data", () => {
  const bot = slack("bot").authentication,
    user = slack("user").authentication;
  assert.ok(bot.method === "authorization_code" && user.method === "authorization_code");
  assert.equal(bot.scopeParameter.name, "scope");
  assert.equal(user.scopeParameter.name, "user_scope");
  const body = {
    ok: true,
    access_token: "bot-token",
    scope: "chat:write,files:read",
    team: { id: "T1", name: "Team" },
    authed_user: {
      access_token: "user-token",
      refresh_token: "user-refresh",
      expires_in: 3600,
      scope: "read,write",
    },
  };
  const a = readTokens(bot.response, { status: 200, body }, now),
    b = readTokens(user.response, { status: 200, body }, now);
  assert.ok(a.kind === "ok" && b.kind === "ok");
  assert.equal(a.credential.accessToken, "bot-token");
  assert.equal(b.credential.accessToken, "user-token");
  assert.deepEqual(b.scopes, ["read", "write"]);
  assert.deepEqual(b.account, { id: "T1", name: "Team" });
  const refresh = readTokens(
    user.refreshResponse ?? user.response,
    {
      status: 200,
      body: {
        ok: true,
        access_token: "rotated-user",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
        enterprise: { id: "E1", name: "Enterprise" },
      },
    },
    now,
  );
  assert.ok(refresh.kind === "ok");
  assert.equal(refresh.credential.accessToken, "rotated-user");
  assert.deepEqual(refresh.account, { id: "E1", name: "Enterprise" });
});
test("Slack HTTP-200 refusal is distinct from uncertain malformed success and server failures", () => {
  const a = slack("bot").authentication;
  assert.ok(a.method === "authorization_code");
  assert.deepEqual(
    readTokens(a.response, { status: 200, body: { ok: false, error: "invalid_grant" } }, now),
    { kind: "error", definitive: true, rejectsGrant: true },
  );
  assert.deepEqual(
    readTokens(a.response, { status: 503, body: { ok: false, error: "invalid_grant" } }, now),
    { kind: "error", definitive: false, rejectsGrant: false },
  );
  assert.deepEqual(readTokens(a.response, { status: 200, body: { ok: true } }, now), {
    kind: "error",
    definitive: false,
    rejectsGrant: false,
  });
});
test("V25 Slack original-byte HMAC, timestamp bounds and verified challenge suppress business events", () => {
  const config = slack("bot").webhook;
  assert.ok(config);
  const secret = "synthetic-webhook-secret",
    timestamp = String(Math.floor(now.getTime() / 1000));
  const body = Buffer.from(
    '{ "type":"event_callback", "token":"legacy-verification-value", "event_id":"e1", "team_id":"T1", "event":{"type":"message"} }',
  );
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:`).update(body).digest("hex")}`;
  const delivery = {
    body,
    now,
    headers: { "x-slack-signature": signature, "x-slack-request-timestamp": timestamp },
  };
  const outcome = verifyDelivery(config, delivery, secret);
  assert.equal(outcome.events[0]?.type, "message");
  assert.equal(JSON.stringify(outcome).includes("legacy-verification-value"), false);
  assert.throws(() =>
    verifyDelivery(
      config,
      { ...delivery, body: Buffer.from(body.toString().replace("message", "changed")) },
      secret,
    ),
  );
  assert.throws(() =>
    verifyDelivery(config, { ...delivery, now: new Date(now.getTime() + 301000) }, secret),
  );
  assert.throws(() =>
    verifyDelivery(config, { ...delivery, now: new Date(now.getTime() - 301000) }, secret),
  );
  const challenge = Buffer.from('{"type":"url_verification","challenge":"verify"}');
  const signed = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:`).update(challenge).digest("hex")}`;
  assert.deepEqual(
    verifyDelivery(
      config,
      {
        ...delivery,
        body: challenge,
        headers: { ...delivery.headers, "x-slack-signature": signed },
      },
      secret,
    ),
    {
      response: { status: 200, contentType: "text/plain; charset=utf-8", body: "verify" },
      events: [],
    },
  );
});
