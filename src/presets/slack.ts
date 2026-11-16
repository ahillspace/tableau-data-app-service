import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  Account,
  EventSource,
  IncomingEvent,
  PresetContext,
  ProviderType,
  TokenReading,
} from "../connections/provider-types.ts";
import type {
  ConnectionDefinition,
  CredentialLease,
  FieldError,
  OutgoingRequest,
} from "../connections/types.ts";
import { ServiceError } from "../platform/errors.ts";

export const SLACK_API = "https://slack.com/api";
export const SLACK_AUTHORIZE = "https://slack.com/oauth/v2/authorize";
export const SLACK_TOKEN = "https://slack.com/api/oauth.v2.access";
/** Slack refuses requests whose signature timestamp is more than five minutes away. */
const SIGNATURE_WINDOW_MS = 5 * 60_000;
/** Errors from `oauth.v2.access` that mean the grant itself is gone and the user must authorize again. */
const GRANT_GONE = new Set([
  "invalid_refresh_token",
  "invalid_grant",
  "token_revoked",
  "token_expired",
  "invalid_code",
  "code_already_used",
]);

type TokenMode = "bot" | "user";

function tokenMode(definition: Pick<ConnectionDefinition, "presetOptions">): TokenMode {
  return definition.presetOptions.tokenMode === "user" ? "user" : "bot";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The workspace, or the enterprise for an organization-wide install that names no team. */
function accountOf(team: unknown, enterprise: unknown): Account | null {
  const t = record(team);
  const e = record(enterprise);
  const id = text(t.id) ?? text(e.id);
  if (!id) return null;
  return { id, name: (text(t.id) ? text(t.name) : text(e.name)) ?? null };
}

function scopeList(value: unknown): string[] {
  return typeof value === "string" ? value.split(/[\s,]+/).filter(Boolean) : [];
}

/** Reads an `oauth.v2.access` response. Slack answers 200 with `ok: false` for refusals. */
function readSlackTokenResponse(
  response: { status: number; body: unknown },
  context: { definition: ConnectionDefinition; refresh: boolean; now: Date },
): TokenReading {
  const body = record(response.body);
  if (response.status !== 200 || body.ok !== true) {
    const named =
      typeof body.error === "string" && /^[\x21-\x7e]{1,100}$/.test(body.error)
        ? body.error
        : undefined;
    const error = named ?? `http-${response.status}`;
    // A named refusal on a 200 or 4xx is definitive; a rate limit or a 5xx is not.
    const definitive =
      named !== undefined &&
      response.status < 500 &&
      response.status !== 429 &&
      named !== "ratelimited";
    return {
      kind: "error",
      error,
      definitive,
      rejectsGrant: definitive && GRANT_GONE.has(named ?? ""),
    };
  }
  // A refresh answers with the rotated token at the top level in both modes; the first exchange
  // carries the installing user's token under `authed_user`.
  const source =
    tokenMode(context.definition) === "user" && !context.refresh ? record(body.authed_user) : body;
  const accessToken = text(source.access_token);
  if (!accessToken)
    return { kind: "error", error: "token-missing", definitive: true, rejectsGrant: false };
  const refreshToken = text(source.refresh_token);
  const expiresIn = Number(source.expires_in);
  return {
    kind: "ok",
    credential: {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(Number.isFinite(expiresIn) && expiresIn > 0
        ? { expiresAt: new Date(context.now.getTime() + expiresIn * 1000).toISOString() }
        : {}),
    },
    account: accountOf(body.team, body.enterprise),
    scopes: scopeList(source.scope),
  };
}

/** Calls a Slack Web API method with the lease's credential placed as the definition says. */
async function callSlack(
  lease: CredentialLease,
  context: PresetContext,
  method: string,
): Promise<Record<string, unknown>> {
  const base = new URL(lease.definition.apiHosts[0] as string);
  const request: OutgoingRequest = {
    target: `${base.pathname.replace(/\/$/, "")}/${method}`,
    headers: [],
  };
  lease.apply(request);
  const response = await context.fetch(new URL(request.target, base.origin), {
    method: "POST",
    headers: request.headers,
    signal: context.signal,
  });
  const body = record(await response.json().catch(() => null));
  if (!response.ok || body.ok !== true)
    throw new ServiceError(
      502,
      "provider-error",
      `Slack ${method} failed (${text(body.error) ?? `http-${response.status}`})`,
    );
  return body;
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function signatureInvalid(): ServiceError {
  return new ServiceError(401, "event-signature-invalid", "The delivery signature did not verify");
}

/**
 * Slack's Events API: verifies `X-Slack-Signature` (v0 HMAC-SHA256 over `v0:{timestamp}:{body}`)
 * and refuses deliveries more than five minutes away from now.
 */
export const slackEventSource: EventSource = {
  signingSecret: "required",
  ingest(delivery, { signingSecret }) {
    if (!signingSecret)
      throw new ServiceError(409, "events-not-configured", "The definition has no signing secret");
    const timestamp = header(delivery.headers, "x-slack-request-timestamp");
    const signature = header(delivery.headers, "x-slack-signature");
    if (
      !timestamp ||
      !/^\d{1,12}$/.test(timestamp) ||
      !signature ||
      !/^v0=[0-9a-f]{64}$/.test(signature)
    )
      throw signatureInvalid();
    if (Math.abs(delivery.now.getTime() - Number(timestamp) * 1000) > SIGNATURE_WINDOW_MS)
      throw new ServiceError(401, "event-too-old", "The delivery is more than five minutes old");
    const expected = createHmac("sha256", signingSecret)
      .update(`v0:${timestamp}:`)
      .update(delivery.body)
      .digest();
    const given = Buffer.from(signature.slice(3), "hex");
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      throw signatureInvalid();
    let payload: Record<string, unknown>;
    try {
      payload = record(JSON.parse(delivery.body.toString("utf8")));
    } catch {
      throw new ServiceError(400, "event-invalid", "The delivery is not JSON");
    }
    if (payload.type === "url_verification")
      return {
        response: { status: 200, contentType: "text/plain", body: String(payload.challenge ?? "") },
        events: [],
      };
    const events: IncomingEvent[] = [];
    if (payload.type === "event_callback") {
      const event = record(payload.event);
      const account =
        text(payload.team_id) ?? text(payload.enterprise_id) ?? text(event.team) ?? "";
      events.push({
        id:
          text(payload.event_id) ??
          `${account}:${String(payload.event_time ?? delivery.now.getTime())}`,
        type: text(event.type) ?? "event_callback",
        account,
        payload,
      });
    }
    return { response: { status: 200 }, events };
  },
};

export const slack: ProviderType = {
  name: "slack",
  oauth: "optional",
  staticCredential: true,
  credentialless: false,
  defaults(input) {
    return {
      apiHosts: [SLACK_API],
      credentialPlacement: { kind: "bearer" },
      ...(input.clientId !== undefined
        ? { authorizationEndpoint: SLACK_AUTHORIZE, tokenEndpoint: SLACK_TOKEN }
        : {}),
    };
  },
  validate(definition) {
    const errors: FieldError[] = [];
    const mode = definition.presetOptions.tokenMode;
    if (mode !== "bot" && mode !== "user")
      errors.push({ path: "presetOptions.tokenMode", rule: "one-of:bot|user" });
    for (const key of Object.keys(definition.presetOptions))
      if (key !== "tokenMode") errors.push({ path: `presetOptions.${key}`, rule: "unknown-field" });
    return errors;
  },
  authorizationParameters(definition) {
    if (!definition.scopes.length) return {};
    const scopes = definition.scopes.join(",");
    return tokenMode(definition) === "user" ? { user_scope: scopes } : { scope: scopes };
  },
  readTokenResponse: readSlackTokenResponse,
  async describeAccount(lease, context) {
    const body = await callSlack(lease, context, "auth.test");
    const team = text(body.team_id);
    const id = team ?? text(body.enterprise_id);
    if (!id) return null;
    return { id, name: (team ? text(body.team) : text(body.enterprise)) ?? null };
  },
  async revoke(lease, context) {
    await callSlack(lease, context, "auth.revoke");
  },
  eventSource: slackEventSource,
};
