import { createHash } from "node:crypto";
import { z } from "zod";
import { ServiceError } from "../http/errors.js";
import { protocolJson } from "../transport/json.js";
import type { ProviderRegistration } from "./registry.js";

const credentialsSchema = z.strictObject({
  accessToken: z.string().min(1).max(4096),
  refreshToken: z.string().max(4096).optional(),
});
export function slackRegistration(
  options: { id?: string; mode?: "personal" | "operator" } = {},
): ProviderRegistration {
  return {
    id: options.id ?? "slack",
    revision: 1,
    mode: options.mode ?? "personal",
    endpoints: { api: { baseUrl: "https://slack.com/api" } },
    credentialsSchema,
    contextSchema: z.strictObject({ tokenMode: z.enum(["bot", "user"]) }),
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
          runtimeContext: { tokenMode },
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
}
