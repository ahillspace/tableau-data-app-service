import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ServiceError } from "../http/errors.js";
import type { EventProvider } from "./types.js";

const contextSchema = z.strictObject({
  signingSecret: z.string().min(1),
  teamId: z.string().min(1),
  appId: z.string().min(1),
});
const challengeSchema = z.object({
  type: z.literal("url_verification"),
  challenge: z.string().min(1).max(2000),
});
const callbackSchema = z.object({
  type: z.literal("event_callback"),
  team_id: z.string(),
  api_app_id: z.string(),
  event_id: z.string(),
  event: z.object({ type: z.string() }).passthrough(),
});

/** Slack's documented HMAC v0/raw-body protocol; no business capability is registered. */
export function slackEventProvider(
  verifyAssociation: EventProvider["verifyAssociation"],
): EventProvider {
  return {
    verifyAssociation,
    forwardingUnavailable: { status: 503, body: "Event forwarding unavailable" },
    eventValid: (_source, event, now) => event.validUntil > now,
    async verify({ privateContext, headers, raw, now }) {
      const context = contextSchema.parse(privateContext);
      const timestamp = headers.get("x-slack-request-timestamp");
      const signature = headers.get("x-slack-signature");
      if (
        !timestamp ||
        !/^\d{1,12}$/.test(timestamp) ||
        !signature ||
        !/^v0=[a-f0-9]{64}$/.test(signature)
      )
        throw new ServiceError(403, "invalid-event-signature", "Invalid event signature");
      const time = Number(timestamp) * 1000;
      if (!Number.isSafeInteger(time) || Math.abs(now.getTime() - time) >= 300000)
        throw new ServiceError(
          403,
          "event-replay-window",
          "Event signature timestamp is outside its validity window",
        );
      const expected = `v0=${createHmac("sha256", context.signingSecret).update(`v0:${timestamp}:`).update(raw).digest("hex")}`;
      if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature)))
        throw new ServiceError(403, "invalid-event-signature", "Invalid event signature");
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
      } catch {
        throw new ServiceError(400, "invalid-event", "Invalid event JSON");
      }
      const challenge = challengeSchema.safeParse(json);
      if (challenge.success)
        return {
          challenge: { status: 200, body: challenge.data.challenge, contentType: "text/plain" },
        };
      const parsed = callbackSchema.safeParse(json);
      if (
        !parsed.success ||
        parsed.data.team_id !== context.teamId ||
        parsed.data.api_app_id !== context.appId
      )
        throw new ServiceError(
          403,
          "invalid-event-account",
          "Event does not match its verified source account",
        );
      return {
        event: {
          id: parsed.data.event_id,
          type: parsed.data.event.type,
          payload: Buffer.from(JSON.stringify(parsed.data.event)),
          mediaType: "application/json",
          validUntil: new Date(time + 300000),
        },
        acknowledgement: { status: 200 },
      };
    },
  };
}
