import { z } from "zod";

export const opaqueId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._~-]+$/);
export const capabilityRefSchema = z.strictObject({
  id: opaqueId,
  version: z.number().int().positive(),
});
export type CapabilityRef = z.infer<typeof capabilityRefSchema>;
export const connectionViewSchema = z.strictObject({
  id: opaqueId,
  providerRegistrationId: opaqueId,
  ownership: z.enum(["personal", "operator"]),
  state: z.enum(["active", "reauthorization-required", "renewal-uncertain", "disconnected"]),
  authorityGeneration: z.number().int().positive(),
  display: z.strictObject({
    label: z.string().max(200).optional(),
    accountLabel: z.string().max(200).optional(),
  }),
  readyEndpoints: z.array(opaqueId),
  connectorReauthRequired: z.boolean(),
  canManage: z.boolean(),
});
export type ConnectionView = z.infer<typeof connectionViewSchema>;
export const jobSubmissionSchema = z.strictObject({
  submissionId: opaqueId,
  capability: capabilityRefSchema,
  connectionId: opaqueId.optional(),
  input: z.json(),
});
export type JobSubmission = z.infer<typeof jobSubmissionSchema>;
export const jobViewSchema = z.strictObject({
  id: opaqueId,
  appId: opaqueId,
  capability: capabilityRefSchema,
  state: z.enum(["queued", "running", "waiting-provider", "succeeded", "failed", "cancelled"]),
  submittedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().optional(),
  executionDeadline: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
  blockedReason: z
    .enum(["reauthorization-required", "observation-authority-unavailable"])
    .optional(),
  progress: z.json().optional(),
  result: z.strictObject({
    availability: z.enum(["not-ready", "available", "expired", "none"]),
    expiresAt: z.iso.datetime().optional(),
  }),
  recordExpiresAt: z.iso.datetime().optional(),
  error: z
    .strictObject({
      code: z.string().max(100),
      message: z.string().max(1000),
      details: z.json().optional(),
    })
    .optional(),
  cancellation: z.strictObject({
    requested: z.boolean(),
    remote: z.enum([
      "not-requested",
      "pending",
      "confirmed",
      "unconfirmed",
      "unsupported",
      "unavailable",
    ]),
  }),
});
export type JobView = z.infer<typeof jobViewSchema>;
export const siteInputSchema = z.strictObject({ deploymentId: opaqueId, siteId: opaqueId });
export const siteViewSchema = siteInputSchema.extend({
  id: opaqueId,
  enabled: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SiteView = z.infer<typeof siteViewSchema>;
export const serviceErrorSchema = z.strictObject({
  error: z.strictObject({ code: z.string(), message: z.string() }),
  requestId: z.string(),
});
export type ServiceErrorBody = z.infer<typeof serviceErrorSchema>;
