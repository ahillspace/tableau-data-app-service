import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";
import type { ConnectionDefinition } from "../src/connections/types.ts";
import { ServiceError } from "../src/platform/errors.ts";
import { slack, slackEventSource } from "../src/presets/slack.ts";

const SECRET = "test-signing-secret";

function definition(
  mode: "bot" | "user",
  scopes = ["chat:write", "channels:read"],
): ConnectionDefinition {
  return {
    id: `slack-${mode}`,
    displayName: "Slack",
    type: "slack",
    ownership: mode === "bot" ? "shared" : "personal",
    apiHosts: ["https://slack.com/api"],
    scopes,
    presetOptions: { tokenMode: mode },
    credentialPlacement: { kind: "bearer" },
    audience: [],
    privateHosts: false,
    enabled: true,
    retired: false,
    generation: 1,
  };
}

const now = new Date("2026-11-15T12:00:00Z");

/** One Slack install response carries the bot token at the top level and the user's under `authed_user`. */
const install = {
  ok: true,
  access_token: "xoxb-bot",
  token_type: "bot",
  scope: "chat:write,channels:read",
  bot_user_id: "U0BOT",
  team: { id: "T1", name: "Workspace" },
  enterprise: null,
  refresh_token: "xoxe-1-bot",
  expires_in: 43200,
  authed_user: {
    id: "U1",
    scope: "search:read",
    access_token: "xoxp-user",
    refresh_token: "xoxe-1-user",
    expires_in: 43200,
    token_type: "user",
  },
};

function signed(body: string, at = now, secret = SECRET) {
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature };
}

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ServiceError);
    return error.code;
  }
  assert.fail("expected a ServiceError");
}

describe("slack preset", () => {
  test("defaults fill hosts and endpoints, and tokenMode is required", () => {
    assert.deepEqual(slack.defaults?.({ clientId: "1.2" }), {
      apiHosts: ["https://slack.com/api"],
      credentialPlacement: { kind: "bearer" },
      authorizationEndpoint: "https://slack.com/oauth/v2/authorize",
      tokenEndpoint: "https://slack.com/api/oauth.v2.access",
    });
    assert.equal(slack.defaults?.({}).tokenEndpoint, undefined);
    assert.deepEqual(
      slack.validate?.({ ...definition("bot"), presetOptions: { tokenMode: "app", extra: 1 } }),
      [
        { path: "presetOptions.tokenMode", rule: "one-of:bot|user" },
        { path: "presetOptions.extra", rule: "unknown-field" },
      ],
    );
  });

  test("bot mode requests scope and user mode requests user_scope", () => {
    assert.deepEqual(slack.authorizationParameters?.(definition("bot")), {
      scope: "chat:write,channels:read",
    });
    assert.deepEqual(slack.authorizationParameters?.(definition("user", ["search:read"])), {
      user_scope: "search:read",
    });
  });

  test("one install backs a bot definition and a user definition", () => {
    const read = slack.readTokenResponse as NonNullable<typeof slack.readTokenResponse>;
    const bot = read(
      { status: 200, body: install },
      { definition: definition("bot"), refresh: false, now },
    );
    const user = read(
      { status: 200, body: install },
      { definition: definition("user"), refresh: false, now },
    );
    assert.equal(bot.kind, "ok");
    assert.equal(user.kind, "ok");
    if (bot.kind !== "ok" || user.kind !== "ok") return;
    assert.equal(bot.credential.accessToken, "xoxb-bot");
    assert.equal(bot.credential.refreshToken, "xoxe-1-bot");
    assert.equal(bot.credential.expiresAt, "2026-11-16T00:00:00.000Z");
    assert.deepEqual(bot.scopes, ["chat:write", "channels:read"]);
    assert.equal(user.credential.accessToken, "xoxp-user");
    assert.deepEqual(user.scopes, ["search:read"]);
    assert.deepEqual(bot.account, { id: "T1", name: "Workspace" });
    assert.deepEqual(user.account, { id: "T1", name: "Workspace" });
    // A rotated user token comes back at the top level on refresh.
    const refreshed = read(
      {
        status: 200,
        body: {
          ok: true,
          access_token: "xoxp-2",
          refresh_token: "xoxe-2",
          expires_in: 60,
          team: { id: "T1" },
        },
      },
      { definition: definition("user"), refresh: true, now },
    );
    assert.equal(refreshed.kind === "ok" && refreshed.credential.accessToken, "xoxp-2");
  });

  test("an organization-wide install records the enterprise", () => {
    const read = slack.readTokenResponse as NonNullable<typeof slack.readTokenResponse>;
    const reading = read(
      {
        status: 200,
        body: {
          ...install,
          team: null,
          enterprise: { id: "E1", name: "Org" },
          is_enterprise_install: true,
        },
      },
      { definition: definition("bot"), refresh: false, now },
    );
    assert.deepEqual(reading.kind === "ok" && reading.account, { id: "E1", name: "Org" });
  });

  test("Slack refusals are definitive; rate limits and server errors are not", () => {
    const read = slack.readTokenResponse as NonNullable<typeof slack.readTokenResponse>;
    const ctx = { definition: definition("bot"), refresh: true, now };
    assert.deepEqual(
      read({ status: 200, body: { ok: false, error: "invalid_refresh_token" } }, ctx),
      {
        kind: "error",
        error: "invalid_refresh_token",
        definitive: true,
        rejectsGrant: true,
      },
    );
    assert.deepEqual(read({ status: 200, body: { ok: false, error: "ratelimited" } }, ctx), {
      kind: "error",
      error: "ratelimited",
      definitive: false,
      rejectsGrant: false,
    });
    assert.equal(
      (read({ status: 503, body: null }, ctx) as { definitive: boolean }).definitive,
      false,
    );
  });

  test("V25 signatures and ages are verified; stale or forged deliveries are refused", () => {
    const context = { definition: definition("bot"), signingSecret: SECRET };
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev1",
      event: { type: "message", text: "hi" },
    });
    const ok = slackEventSource.ingest(
      { headers: signed(body), body: Buffer.from(body), now },
      context,
    );
    assert.equal(ok.response.status, 200);
    assert.deepEqual(
      ok.events.map((e) => [e.id, e.type, e.account]),
      [["Ev1", "message", "T1"]],
    );
    const old = new Date(now.getTime() - 5 * 60_000 - 1000);
    assert.equal(
      errorCode(() =>
        slackEventSource.ingest(
          { headers: signed(body, old), body: Buffer.from(body), now },
          context,
        ),
      ),
      "event-too-old",
    );
    const future = new Date(now.getTime() + 5 * 60_000 + 1000);
    assert.equal(
      errorCode(() =>
        slackEventSource.ingest(
          { headers: signed(body, future), body: Buffer.from(body), now },
          context,
        ),
      ),
      "event-too-old",
    );
    assert.equal(
      errorCode(() =>
        slackEventSource.ingest(
          { headers: signed(body, now, "wrong"), body: Buffer.from(body), now },
          context,
        ),
      ),
      "event-signature-invalid",
    );
    assert.equal(
      errorCode(() =>
        slackEventSource.ingest(
          { headers: signed(body), body: Buffer.from(`${body} `), now },
          context,
        ),
      ),
      "event-signature-invalid",
    );
    assert.equal(
      errorCode(() =>
        slackEventSource.ingest({ headers: {}, body: Buffer.from(body), now }, context),
      ),
      "event-signature-invalid",
    );

    const enterprise = JSON.stringify({
      type: "event_callback",
      enterprise_id: "E1",
      event_id: "Ev2",
      event: { type: "team_join" },
    });
    assert.equal(
      slackEventSource.ingest(
        { headers: signed(enterprise), body: Buffer.from(enterprise), now },
        context,
      ).events[0]?.account,
      "E1",
    );

    const challenge = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    assert.deepEqual(
      slackEventSource.ingest(
        { headers: signed(challenge), body: Buffer.from(challenge), now },
        context,
      ),
      {
        response: { status: 200, contentType: "text/plain", body: "abc123" },
        events: [],
      },
    );
  });
});
