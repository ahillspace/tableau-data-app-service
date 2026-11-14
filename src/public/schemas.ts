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

export const headerProfileSchema = z.strictObject({
  version: z.literal(1),
  physicalBytes: z.number().int().positive(),
  nativeBytes: z.number().int().positive(),
  pairs: z.number().int().positive(),
  jsonBytes: z.number().int().positive(),
  encodedBytes: z.number().int().positive(),
});
export const providerViewSchema = z.strictObject({
  id: opaqueId,
  mode: z.enum(["none", "personal", "operator"]),
  endpoints: z.array(opaqueId),
  setupModes: z.array(z.enum(["static", "oauth"])),
  transport: headerProfileSchema,
});
export type ProviderView = z.infer<typeof providerViewSchema>;
export const replacementSchema = z.strictObject({
  connectionId: opaqueId,
  expectedAuthorityGeneration: z.number().int().positive(),
});
export const staticConnectionInputSchema = z.strictObject({
  providerRegistrationId: opaqueId,
  inputs: z.record(z.string(), z.json()),
  replacement: replacementSchema.optional(),
});
export type StaticConnectionInput = z.infer<typeof staticConnectionInputSchema>;
export const authorizationBeginSchema = z.strictObject({
  providerRegistrationId: opaqueId,
  inputs: z.record(z.string(), z.json()).optional(),
  replacement: replacementSchema.optional(),
  permissionOption: opaqueId.optional(),
  initiationVerifier: z.string().regex(/^[a-f0-9]{64}$/),
});
export const authorizationViewSchema = z.strictObject({
  id: opaqueId,
  state: z.enum(["pending", "exchanging", "succeeded", "failed", "cancelled", "expired"]),
  expiresAt: z.iso.datetime(),
  connectionId: opaqueId.optional(),
  error: z.strictObject({ code: z.string(), message: z.string() }).optional(),
});
export type AuthorizationBegin = z.infer<typeof authorizationBeginSchema>;
export type AuthorizationView = z.infer<typeof authorizationViewSchema>;
const jsonContract = z.strictObject({ kind: z.literal("json"), schema: z.json() });
const httpContract = z.strictObject({ kind: z.literal("http") });
export const capabilityDefinitionSchema = z.strictObject({
  ref: capabilityRefSchema,
  providerRegistrationId: opaqueId,
  http: z
    .strictObject({
      input: z.union([jsonContract, httpContract]),
      response: z.union([jsonContract, httpContract]),
    })
    .optional(),
  job: z
    .strictObject({
      inputSchema: z.json(),
      resultSchema: z.json(),
      inputLimitBytes: z.number().int().positive().optional(),
      resultLimitBytes: z.number().int().positive().optional(),
      executionLimitSeconds: z.number().int().positive().optional(),
    })
    .optional(),
});
export type CapabilityDefinition = z.infer<typeof capabilityDefinitionSchema>;
export const providerCollectionSchema = z.strictObject({ items: z.array(providerViewSchema) });
export const connectionCollectionSchema = z.strictObject({ items: z.array(connectionViewSchema) });
export const capabilityCollectionSchema = z.strictObject({
  items: z.array(capabilityDefinitionSchema),
});
export const sessionBeginSchema = z.strictObject({
  appId: opaqueId,
  deploymentId: opaqueId,
  initiationVerifier: z.string().regex(/^[a-f0-9]{64}$/),
});
export const sessionTransactionSchema = z.strictObject({
  id: opaqueId,
  expiresAt: z.iso.datetime(),
  launchUrl: z.url(),
});
export const sessionResponseSchema = z.strictObject({
  accessToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.iso.datetime(),
  authenticationExpiresAt: z.iso.datetime(),
  identity: z.strictObject({ deploymentId: opaqueId, siteId: opaqueId, subjectId: opaqueId }),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

const liveMediaType = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\x20-\x7e]+$/);
const liveRevision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const liveEncodedBytes = z.string().regex(/^[A-Za-z0-9_-]*$/);
export const publicLiveDataSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("provider"),
    id: opaqueId,
    provider: opaqueId,
    connectionId: opaqueId.optional(),
    type: opaqueId,
    payloadEncoding: z.literal("base64url"),
    payloadMediaType: liveMediaType,
    payload: liveEncodedBytes,
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("job-hint"),
    id: opaqueId,
    jobId: opaqueId,
    revision: liveRevision,
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("resync-required"),
    reason: z.enum(["connected", "possible-loss"]),
  }),
]);
export type PublicLiveData = z.infer<typeof publicLiveDataSchema>;
