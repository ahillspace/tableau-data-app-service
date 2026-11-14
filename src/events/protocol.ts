import { z } from "zod";
import { opaqueId, type PublicLiveData } from "../public/schemas.js";

const mediaType = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\x20-\x7e]+$/);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const date = z.iso.datetime();
const encodedBytes = z.string().regex(/^[A-Za-z0-9_-]*$/);
const base = { version: z.literal(1), eventId: opaqueId, ingressAt: date, expiresAt: date };
export const liveEnvelopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...base,
    kind: z.literal("provider"),
    sourceId: opaqueId,
    sourceRevision: revision,
    type: opaqueId,
    validUntil: date,
    payloadEncoding: z.literal("base64url"),
    payloadMediaType: mediaType,
    payload: encodedBytes,
  }),
  z.strictObject({ ...base, kind: z.literal("job-hint"), jobId: opaqueId, jobRevision: revision }),
]);
export type LiveEnvelope = z.infer<typeof liveEnvelopeSchema>;
export type EventLimits = {
  payloadBytes: number;
  maxAgeMs: number;
  clockSkewMs: number;
  publisherBytes: number;
  subscriberBytes: number;
  streamBytes: number;
  aggregateBytes: number;
  stallMs: number;
  heartbeatMs: number;
};
// Metadata has bounded fields with ASCII/base64 payload. This includes JSON/SSE framing headroom.
export function eventBudgets(limits: EventLimits) {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < (name === "clockSkewMs" ? 0 : 1))
      throw new TypeError(`Invalid event ${name}`);
  }
  const encodedPayload = Math.ceil((4 * limits.payloadBytes) / 3);
  const envelopeBytes = encodedPayload + 4096;
  const frameBytes = encodedPayload + 4096;
  if (
    [limits.publisherBytes, limits.subscriberBytes].some((budget) => budget < envelopeBytes) ||
    [limits.streamBytes, limits.aggregateBytes].some((budget) => budget < frameBytes)
  )
    throw new TypeError("Accepted event must fit every event transport budget");
  return { encodedPayload, envelopeBytes, frameBytes };
}
export function freshEnvelope(event: LiveEnvelope, limits: EventLimits, now = Date.now()): boolean {
  const ingress = Date.parse(event.ingressAt),
    expires = Date.parse(event.expiresAt);
  return (
    ingress <= now + limits.clockSkewMs &&
    expires > ingress &&
    expires - ingress <= limits.maxAgeMs &&
    expires > now &&
    (event.kind !== "provider" || Date.parse(event.validUntil) > now)
  );
}
export function decodeEnvelope(raw: string, limits: EventLimits): LiveEnvelope {
  const budgets = eventBudgets(limits);
  if (Buffer.byteLength(raw) > budgets.envelopeBytes) throw new Error("Oversized event envelope");
  const parsed: unknown = JSON.parse(raw);
  // Bound before regex/schema work and before base64 allocation.
  if (
    parsed &&
    typeof parsed === "object" &&
    "payload" in parsed &&
    typeof parsed.payload === "string" &&
    parsed.payload.length > budgets.encodedPayload
  )
    throw new Error("Oversized encoded payload");
  const event = liveEnvelopeSchema.parse(parsed);
  if (event.kind === "provider") {
    const bytes = Buffer.from(event.payload, "base64url");
    if (bytes.byteLength > limits.payloadBytes || bytes.toString("base64url") !== event.payload)
      throw new Error("Invalid payload encoding");
  }
  return event;
}
export function frame(data: PublicLiveData): string {
  return `event: ${data.kind}\ndata: ${JSON.stringify(data)}\n\n`;
}
