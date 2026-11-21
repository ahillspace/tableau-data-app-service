import { z } from "zod";
import { operationName } from "../extensions/provider.ts";
import type { FieldError } from "../platform/errors.ts";
import { fieldErrors } from "../platform/validation.ts";
import { normalizeApiHost } from "./hosts.ts";
import type { ConnectionDefinition, Definition, DefinitionWrite } from "./types.ts";

export { normalizeApiHost } from "./hosts.ts";
export type DefinitionInput = Definition;
const text = z.string().min(1).max(2000);
const secret = z
  .string()
  .min(1)
  .refine((s) => Buffer.byteLength(s, "utf8") <= 65536, "max-bytes:65536");
const selector = z
  .array(
    z
      .string()
      .min(1)
      .max(128)
      .refine((s) => !["__proto__", "prototype", "constructor"].includes(s), "own-property"),
  )
  .min(1)
  .max(8);
const selectors = z.array(selector).min(1).max(4);
const predicate = z.union([
  z.strictObject({
    path: selector,
    equals: z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]),
  }),
  z.strictObject({ path: selector, exists: z.boolean() }),
]);
const rules = z.strictObject({
  successStatuses: z.array(z.number().int().min(200).max(299)).min(1).max(100),
  success: z.array(predicate).max(8).optional(),
  failure: z.array(predicate).max(8).optional(),
  rejectedGrant: z.array(predicate).max(8).optional(),
});
const response = z.strictObject({
  format: z.enum(["json", "form"]),
  rules,
  mapping: z.strictObject({
    accessToken: selector,
    refreshToken: selector.optional(),
    expiresIn: selector.optional(),
    scope: selector.optional(),
    scopeSeparator: z.string().min(1).max(8).optional(),
    accountId: selectors.optional(),
    accountName: selectors.optional(),
  }),
});
const https = text
  .refine((value) => {
    try {
      const u = new URL(value);
      return (
        u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        !u.hash &&
        !u.hostname.includes("*")
      );
    } catch {
      return false;
    }
  }, "https-url")
  .transform((s) => new URL(s).href);
const header = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/);
const headerValue = z
  .string()
  .max(200)
  .refine((s) => !/[\r\n\0]/.test(s), "header-safe");
const jwt = z.strictObject({
  algorithm: z.enum(["RS256", "ES256"]),
  issuer: z.union([text, z.strictObject({ credential: z.literal("issuer") })]),
  subject: z
    .union([text, z.strictObject({ credential: z.enum(["subject", "issuer"]) })])
    .optional(),
  audience: z.union([text, z.strictObject({ source: z.literal("selectedOrigin") })]),
  scope: z.strictObject({ source: z.literal("scopes"), separator: z.enum([" ", ","]) }).optional(),
  keyId: z.union([text, z.strictObject({ credential: z.literal("keyId") })]).optional(),
  ttlSeconds: z.number().int().min(1).max(3600),
});
const clientAuthentication = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("none"), clientId: text.optional() }),
  z.strictObject({ method: z.literal("client_secret_basic"), clientId: text }),
  z.strictObject({ method: z.literal("client_secret_post"), clientId: text }),
  z.strictObject({ method: z.literal("private_key_jwt"), clientId: text, jwt }),
]);
const ownedParameters = new Set([
  "grant_type",
  "state",
  "code",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "code_verifier",
  "assertion",
  "client_assertion",
  "client_assertion_type",
  "client_id",
  "client_secret",
  "response_type",
  "refresh_token",
]);
const scopeParameter = z.strictObject({
  name: text.refine((name) => !ownedParameters.has(name), "unreserved-parameter"),
  separator: z.enum([" ", ","]),
});
const parameters = z
  .record(text, z.string().max(2000))
  .refine(
    (v) => Object.keys(v).length <= 32 && Object.keys(v).every((k) => !ownedParameters.has(k)),
    "literal-parameters:bounded-unreserved",
  );
const authentication = z
  .discriminatedUnion("method", [
    z.strictObject({
      method: z.literal("authorization_code"),
      authorizationEndpoint: https,
      tokenEndpoint: https,
      refreshEndpoint: https.optional(),
      clientAuthentication,
      pkce: z.enum(["S256", "none"]),
      scopeParameter,
      authorizeParameters: parameters.optional(),
      tokenParameters: parameters.optional(),
      refreshParameters: parameters.optional(),
      response,
      refreshResponse: response.optional(),
    }),
    z.strictObject({
      method: z.literal("client_credentials"),
      tokenEndpoint: https,
      clientAuthentication,
      scopeParameter,
      tokenParameters: parameters.optional(),
      response,
    }),
    z.strictObject({
      method: z.literal("jwt_bearer"),
      tokenEndpoint: https,
      clientAuthentication,
      jwt,
      tokenParameters: parameters.optional(),
      response,
    }),
    z.strictObject({ method: z.literal("signed_jwt_direct"), jwt }),
    z.strictObject({ method: z.literal("static") }),
    z.strictObject({ method: z.literal("none") }),
  ])
  .superRefine((a, ctx) => {
    const issue = (path: string[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    if (a.method === "jwt_bearer" && typeof a.jwt.audience !== "string")
      issue(["jwt", "audience"], "literal-audience");
    if ("clientAuthentication" in a) {
      const c = a.clientAuthentication;
      if (a.method === "authorization_code" && !c.clientId)
        issue(["clientAuthentication", "clientId"], "required");
      if (
        c.method === "private_key_jwt" &&
        [c.jwt.issuer, c.jwt.subject, c.jwt.audience, c.jwt.keyId].some(
          (v) => v !== undefined && typeof v !== "string",
        )
      )
        issue(["clientAuthentication", "jwt"], "literal-client-claims");
      if (c.method === "private_key_jwt") {
        if (c.jwt.issuer !== c.clientId)
          issue(["clientAuthentication", "jwt", "issuer"], "client-id-match");
        if (c.jwt.subject !== undefined && c.jwt.subject !== c.clientId)
          issue(["clientAuthentication", "jwt", "subject"], "client-id-match");
      }
    }
  });
const requestValue = z.union([
  z.strictObject({ literal: z.string().max(2000) }),
  z.strictObject({ source: z.enum(["accessToken", "refreshToken", "clientId"]) }),
]);
const requestFields = {
  url: https,
  method: z.enum(["GET", "POST", "DELETE"]),
  credential: z.enum(["none", "accessToken"]),
  parameters: z
    .record(text, requestValue)
    .refine((v) => Object.keys(v).length <= 32, "max:32")
    .optional(),
  encoding: z.enum(["query", "form", "json"]),
  response: rules,
};
const protocolRequest = z
  .strictObject(requestFields)
  .refine((r) => r.method !== "GET" || r.encoding === "query", "get-query-only");
const accountLookup = z
  .strictObject({ ...requestFields, id: selectors, name: selectors.optional() })
  .refine((r) => r.method !== "GET" || r.encoding === "query", "get-query-only");
const eventValue = z.union([
  z.strictObject({ json: selector }),
  z.strictObject({ header }),
  z.strictObject({ literal: text }),
]);
export const webhookSchema = z.strictObject({
  verification: z.discriminatedUnion("kind", [
    z
      .strictObject({
        kind: z.literal("hmac"),
        algorithm: z.literal("sha256"),
        header,
        prefix: headerValue,
        encoding: z.enum(["hex", "base64"]),
        timestamp: z
          .strictObject({ header, toleranceSeconds: z.number().int().min(1).max(3600) })
          .optional(),
        parts: z
          .array(
            z.union([
              z.strictObject({ literal: z.string().max(256) }),
              z.strictObject({ timestamp: z.literal(true) }),
              z.strictObject({ rawBody: z.literal(true) }),
            ]),
          )
          .min(1)
          .max(5),
      })
      .superRefine((v, ctx) => {
        if (v.parts.some((p) => "timestamp" in p) && !v.timestamp)
          ctx.addIssue({
            code: "custom",
            path: ["timestamp"],
            message: "timestamp-header-required",
          });
      }),
    z.strictObject({
      kind: z.literal("compound-hmac"),
      header,
      timestampKey: text,
      signatureKey: text,
      separator: z.string().min(1).max(8),
      algorithm: z.literal("sha256"),
      encoding: z.literal("hex"),
      toleranceSeconds: z.number().int().min(1).max(3600),
    }),
    z.strictObject({ kind: z.literal("body-secret"), batch: selector, secret: selector }),
  ]),
  handshake: z
    .discriminatedUnion("kind", [
      z
        .strictObject({
          kind: z.literal("verified-json-echo"),
          when: predicate,
          value: selector,
          response: z.enum(["json", "text"]),
          responseKey: text.optional(),
        })
        .refine((v) => v.response !== "json" || v.responseKey !== undefined, "json-response-key"),
      z.strictObject({
        kind: z.literal("query-echo"),
        parameter: text,
        response: z.literal("text"),
      }),
    ])
    .optional(),
  event: z.strictObject({
    batch: selector.optional(),
    id: eventValue.optional(),
    type: eventValue,
    account: z.array(eventValue).min(1).max(4),
    payload: selector.optional(),
    omit: z.array(selector).max(8).optional(),
  }),
});
const placement = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("bearer") }),
  z.strictObject({ kind: z.literal("basic") }),
  z.strictObject({ kind: z.literal("query"), name: text }),
  z.strictObject({
    kind: z.literal("header"),
    name: header.refine(
      (s) =>
        ![
          "host",
          "connection",
          "keep-alive",
          "te",
          "trailer",
          "transfer-encoding",
          "upgrade",
          "content-length",
        ].includes(s.toLowerCase()) && !/^(tableau-service-|proxy-)/i.test(s),
      "credential-header",
    ),
    prefix: headerValue.optional(),
  }),
]);
export const credentialSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("token"), value: secret }),
  z.strictObject({
    kind: z.literal("basic"),
    username: secret.refine((s) => !/[:\r\n]/.test(s), "basic-username"),
    password: secret.refine((s) => !/[\r\n]/.test(s), "basic-password"),
  }),
  z.strictObject({
    kind: z.literal("jwt"),
    privateKey: secret,
    issuer: text,
    subject: text.optional(),
    keyId: text.optional(),
  }),
  z.strictObject({ kind: z.literal("import"), value: secret }),
]);
export const secretWritesSchema = z.strictObject({
  clientSecret: secret.nullable().optional(),
  signingSecret: secret.nullable().optional(),
  signingPrivateKey: secret.nullable().optional(),
});
const definitionSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  displayName: z
    .string()
    .min(1)
    .max(200)
    .refine((s) => !/[\x00-\x1f\x7f]/.test(s), "display-name"),
  ownership: z.enum(["shared", "personal"]),
  apiHosts: z
    .array(
      z
        .string()
        .refine((v) => normalizeApiHost(v) !== undefined, "https-base-url")
        .transform((v) => normalizeApiHost(v) as string),
    )
    .min(1)
    .max(50)
    .refine((v) => new Set(v).size === v.length, "unique"),
  credentialPlacement: placement.default({ kind: "bearer" }),
  authentication,
  audience: z.array(z.string()).max(1000),
  scopes: z
    .array(
      z
        .string()
        .min(1)
        .max(500)
        .regex(/^[\x21-\x7e]+$/),
    )
    .max(100)
    .default([]),
  reauthorizationInterval: z
    .number()
    .int()
    .min(60)
    .max(10 * 365 * 86400)
    .optional(),
  privateHosts: z.boolean().default(false),
  enabled: z.boolean().default(true),
  accountLookup: accountLookup.optional(),
  revocation: protocolRequest.optional(),
  webhook: webhookSchema.optional(),
  operations: z
    .record(
      z.string().regex(operationName),
      z.strictObject({
        enabled: z.boolean(),
        contractMajor: z.number().int().positive(),
        options: z.record(z.string(), z.json()),
      }),
    )
    .default({}),
  credentialImport: z
    .strictObject({
      format: z.literal("json"),
      fields: z.strictObject({
        privateKey: selector,
        issuer: selector,
        subject: selector.optional(),
        keyId: selector.optional(),
      }),
      tokenEndpoint: selector.optional(),
    })
    .optional(),
});
/** Catalog defaults use the same field schemas; incomplete top-level setup stays editable. */
export const definitionTemplateSchema = definitionSchema.omit({ operations: true }).partial();
export const IN_PLACE_FIELDS = new Set([
  "displayName",
  "scopes",
  "audience",
  "reauthorizationInterval",
  "enabled",
  "operations",
  "secrets",
  "credential",
  "expectedVersion",
]);
export function unknownKeyErrors(
  input: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): FieldError[] {
  return Object.keys(input)
    .filter((k) => !allowed.has(k))
    .map((k) => ({
      path: k,
      rule: k in definitionSchema.shape ? "requires-redefine" : "unknown-field",
    }));
}
export function validateDefinition(
  raw: unknown,
  context: { siteIds: ReadonlySet<string> },
): { definition: DefinitionInput; errors: FieldError[] } {
  const parsed = definitionSchema.safeParse(raw);
  const errors = parsed.success ? [] : fieldErrors(parsed.error);
  if (parsed.success) {
    parsed.data.audience.forEach((id, i) => {
      if (!context.siteIds.has(id)) errors.push({ path: `audience.${i}`, rule: "trusted-site" });
    });
    const d = parsed.data;
    if (d.authentication.method === "client_credentials" && d.ownership !== "shared")
      errors.push({ path: "ownership", rule: "client-credentials-shared-only" });
    if (d.credentialPlacement.kind === "basic" && d.authentication.method !== "static")
      errors.push({ path: "credentialPlacement", rule: "static-basic-only" });
    if (
      d.credentialImport &&
      !["jwt_bearer", "signed_jwt_direct"].includes(d.authentication.method)
    )
      errors.push({ path: "credentialImport", rule: "jwt-method-only" });
    if (d.credentialImport?.tokenEndpoint && d.authentication.method !== "jwt_bearer")
      errors.push({ path: "credentialImport.tokenEndpoint", rule: "token-endpoint-required" });
  }
  return { definition: parsed.data as Definition, errors };
}
export function publicDefinition(d: ConnectionDefinition): Definition {
  const { generation: _g, retired: _r, version: _v, secretGeneration: _s, ...definition } = d;
  return definition;
}
export type ValidatedWrite = Pick<DefinitionWrite, "secrets" | "credential">;
