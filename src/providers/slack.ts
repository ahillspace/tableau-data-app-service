import { createHash } from "node:crypto";
import * as oauth from "oauth4webapi";
import { z } from "zod";
import { ServiceError } from "../http/errors.js";
import { protocolJson } from "../transport/json.js";
import type { ProviderRegistration } from "./registry.js";

const credentialsSchema = z.strictObject({
  accessToken: z.string().min(1).max(4096),
  refreshToken: z.string().max(4096).optional(),
});
export function slackRegistration(
  options: { id?: string; mode?: "personal" | "operator"; oauth?: SlackOAuthOptions } = {},
): ProviderRegistration {
  const registration: ProviderRegistration = {
    id: options.id ?? "slack",
    revision: 1,
    mode: options.mode ?? "personal",
    endpoints: {
      api: {
        baseUrl: "https://slack.com/api",
        blockedPaths: ["/api/oauth.v2.access", "/api/oauth.v2.exchange", "/api/oauth.access"],
      },
    },
    credentialsSchema,
    contextSchema: z.strictObject({
      tokenMode: z.enum(["bot", "user"]),
      teamId: z.string(),
      userId: z.string(),
      botId: z.string().optional(),
    }),
    attach: (snapshot) =>
      new Headers({
        authorization: `Bearer ${credentialsSchema.parse(snapshot.credentials).accessToken}`,
      }),
    staticSetup: {
      remote: true,
      mayInvalidate: false,
      inputSchema: z.strictObject({
        token: z.string().min(1).max(4096),
        tokenMode: z.enum(["bot", "user"]),
      }),
      prepare: async (input, context) => {
        const { token, tokenMode } = z
          .strictObject({ token: z.string(), tokenMode: z.enum(["bot", "user"]) })
          .parse(input);
        const response = await context.request("https://slack.com/api/auth.test", {
          method: "POST",
          headers: new Headers({ authorization: `Bearer ${token}` }),
        });
        const data = z
          .object({
            ok: z.boolean(),
            team_id: z.string().optional(),
            user_id: z.string().optional(),
            bot_id: z.string().optional(),
            team: z.string().max(200).optional(),
            user: z.string().max(200).optional(),
          })
          .parse(await protocolJson(response));
        if (
          !response.ok ||
          !data.ok ||
          !data.team_id ||
          !data.user_id ||
          (tokenMode === "bot" ? !data.bot_id : !!data.bot_id)
        )
          throw new ServiceError(
            422,
            "provider-authentication-failed",
            "Slack token validation failed",
          );
        return {
          credentials: { accessToken: token },
          runtimeContext: {
            tokenMode,
            teamId: data.team_id,
            userId: data.user_id,
            ...(data.bot_id ? { botId: data.bot_id } : {}),
          },
          display: { label: "Slack", ...(data.team ? { accountLabel: data.team } : {}) },
          expiresAt: null,
          // A static user token does not prove application/grant continuity.
          accountKey:
            tokenMode === "bot"
              ? createHash("sha256")
                  .update(JSON.stringify([data.team_id, data.bot_id]))
                  .digest("hex")
              : null,
          verifiedReauthorization: true,
        };
      },
    },
    capabilities: [],
  };
  if (options.oauth) {
    const definition = (registration.oauth = slackOAuth(options.oauth, registration));
    registration.renewal = {
      mayInvalidate: true,
      async renew(previous, context) {
        const credentials = credentialsSchema.parse(previous.credentials);
        if (!credentials.refreshToken)
          throw new ServiceError(
            422,
            "reauthorization-required",
            "Slack refresh token is unavailable",
          );
        const response = await oauth.refreshTokenGrantRequest(
          definition.metadata,
          { client_id: definition.clientId },
          definition.clientSecret ? oauth.ClientSecretPost(definition.clientSecret) : oauth.None(),
          credentials.refreshToken,
          {
            [oauth.customFetch]: (url, init) =>
              context.request(url, {
                method: init.method,
                headers: new Headers(init.headers),
                body: init.body.toString(),
              }),
            signal: context.signal,
          },
        );
        if (!response.ok)
          throw new ServiceError(422, "provider-renewal-failed", "Slack renewal failed");
        return definition.parseTokenResponse(await protocolJson(response), {
          request: context.request,
          previous,
          renewal: true,
        });
      },
    };
  }
  return registration;
}

export type SlackOAuthOptions = {
  clientId: string;
  clientSecret?: string;
  callbackUri: string;
  tokenMode: "bot" | "user";
  scopes: readonly string[];
  pkceEnabled: boolean;
};
function slackOAuth(
  config: SlackOAuthOptions,
  registration: ProviderRegistration,
): NonNullable<ProviderRegistration["oauth"]> {
  if (config.pkceEnabled ? !!config.clientSecret : !config.clientSecret)
    throw new Error(
      "Slack requires either configured public PKCE or confidential client authentication",
    );
  return {
    metadata: {
      issuer: "https://slack.com",
      authorization_endpoint: "https://slack.com/oauth/v2/authorize",
      token_endpoint: "https://slack.com/api/oauth.v2.access",
    },
    clientId: config.clientId,
    ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
    callbackUri: config.callbackUri,
    scope: config.tokenMode === "bot" ? config.scopes.join(",") : "",
    pkce: config.pkceEnabled,
    ...(config.tokenMode === "user"
      ? { authorizationParameters: { user_scope: config.scopes.join(",") } }
      : {}),
    launchMayInvalidate: true,
    exchangeMayInvalidate: true,
    async parseTokenResponse(raw, context) {
      const data = z
        .object({
          ok: z.boolean(),
          access_token: z.string().optional(),
          refresh_token: z.string().optional(),
          expires_in: z.number().positive().optional(),
          team: z.object({ id: z.string() }).optional(),
          bot_user_id: z.string().optional(),
          authed_user: z
            .object({
              id: z.string(),
              access_token: z.string().optional(),
              refresh_token: z.string().optional(),
              expires_in: z.number().positive().optional(),
            })
            .optional(),
        })
        .parse(raw);
      if (!data.ok)
        throw new ServiceError(422, "provider-authorization-failed", "Slack authorization failed");
      const selected = config.tokenMode === "user" && !context.renewal ? data.authed_user : data;
      if (!selected?.access_token || (selected.expires_in && !selected.refresh_token))
        throw new ServiceError(
          502,
          "invalid-provider-response",
          "Slack token response is incomplete",
        );
      const setup = registration.staticSetup;
      if (!setup) throw new Error("Slack validation declaration missing");
      const validated = await setup.prepare(
        { token: selected.access_token, tokenMode: config.tokenMode },
        { signal: new AbortController().signal, request: context.request },
      );
      const account = registration.contextSchema.parse(validated.runtimeContext);
      if (
        (data.team && data.team.id !== account.teamId) ||
        (config.tokenMode === "user" &&
          data.authed_user &&
          data.authed_user.id !== account.userId) ||
        (config.tokenMode === "bot" && data.bot_user_id && data.bot_user_id !== account.userId)
      )
        throw new ServiceError(502, "invalid-provider-account", "Slack account evidence conflicts");
      const accountKey = createHash("sha256")
        .update(
          JSON.stringify([
            config.clientId,
            config.tokenMode,
            account.teamId,
            account.userId,
            account.botId ?? null,
          ]),
        )
        .digest("hex");
      if (context.renewal && accountKey !== context.previous?.accountKey)
        throw new ServiceError(502, "invalid-provider-account", "Slack renewal account changed");
      return {
        ...validated,
        credentials: {
          accessToken: selected.access_token,
          ...(selected.refresh_token ? { refreshToken: selected.refresh_token } : {}),
        },
        accountKey,
        expiresAt: selected.expires_in ? new Date(Date.now() + selected.expires_in * 1000) : null,
        verifiedReauthorization: !context.renewal,
      };
    },
  };
}
