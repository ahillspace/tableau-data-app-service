import type { FieldError } from "../platform/errors.ts";
import type { ProviderType, ProviderTypes } from "./provider-types.ts";
import type { ConnectionDefinition, Placement } from "./types.ts";

/** The fields an operator writes. `generation` and `retired` are set by the service. */
export type DefinitionInput = Omit<ConnectionDefinition, "generation" | "retired">;

const FIELDS = [
  "id",
  "displayName",
  "type",
  "ownership",
  "apiHosts",
  "authorizationEndpoint",
  "tokenEndpoint",
  "clientId",
  "tokenAuthentication",
  "scopes",
  "presetOptions",
  "credentialPlacement",
  "audience",
  "reauthorizationInterval",
  "privateHosts",
  "enabled",
] as const;

/** Fields that change in place; every other field needs a redefinition. */
export const IN_PLACE_FIELDS = new Set([
  "displayName",
  "scopes",
  "audience",
  "reauthorizationInterval",
  "enabled",
]);

const SECRET_FIELDS = new Set(["clientSecret", "signingSecret", "credential"]);
const SERVICE_FIELDS = new Set([
  "generation",
  "retired",
  "clientSecretSet",
  "signingSecretSet",
  "secretsSetAt",
]);
const SLUG = /^[a-z][a-z0-9-]{0,62}$/;
const PRINTABLE = /^[\x20-\x7e -￿]+$/u;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESERVED_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

export type ValidationContext = {
  types: ProviderTypes;
  /** Trusted site record IDs that exist now; audiences may name only these. */
  siteIds: ReadonlySet<string>;
};

/** Classifies the keys of an operator payload. Secrets are never accepted in a definition body. */
export function unknownKeyErrors(
  input: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): FieldError[] {
  const errors: FieldError[] = [];
  for (const key of Object.keys(input)) {
    if (allowed.has(key)) continue;
    if (SECRET_FIELDS.has(key)) errors.push({ path: key, rule: "use-secret-link" });
    else if (SERVICE_FIELDS.has(key)) errors.push({ path: key, rule: "set-by-service" });
    else if ((FIELDS as readonly string[]).includes(key))
      errors.push({ path: key, rule: "requires-redefine" });
    else errors.push({ path: key, rule: "unknown-field" });
  }
  return errors;
}

/** An HTTPS URL with no credentials or fragment; returns its normalized form. */
function httpsUrl(value: unknown, allowQuery: boolean): string | undefined {
  if (typeof value !== "string" || value.length > 2000) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !url.hostname)
    return undefined;
  if (!allowQuery && url.search) return undefined;
  return url.href;
}

/** An API host is an HTTPS base URL; its path is the base path native requests must stay under. */
export function normalizeApiHost(value: unknown): string | undefined {
  const href = httpsUrl(value, false);
  return href === undefined ? undefined : href.replace(/\/+$/, "");
}

function placement(value: unknown, errors: FieldError[]): Placement {
  if (value === undefined) return { kind: "bearer" };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push({ path: "credentialPlacement", rule: "type:object" });
    return { kind: "bearer" };
  }
  const p = value as Record<string, unknown>;
  const extra = Object.keys(p).filter((k) => !["kind", "name", "prefix"].includes(k));
  for (const key of extra)
    errors.push({ path: `credentialPlacement.${key}`, rule: "unknown-field" });
  switch (p.kind) {
    case "bearer":
      if (p.name !== undefined)
        errors.push({ path: "credentialPlacement.name", rule: "not-used-by-kind" });
      if (p.prefix !== undefined)
        errors.push({ path: "credentialPlacement.prefix", rule: "not-used-by-kind" });
      return { kind: "bearer" };
    case "header": {
      const name = p.name;
      if (
        typeof name !== "string" ||
        name.length > 200 ||
        !TOKEN.test(name) ||
        RESERVED_HEADERS.has(name.toLowerCase()) ||
        name.toLowerCase().startsWith("tableau-service-") ||
        name.toLowerCase().startsWith("proxy-")
      )
        errors.push({ path: "credentialPlacement.name", rule: "header-name" });
      if (
        p.prefix !== undefined &&
        (typeof p.prefix !== "string" || p.prefix.length > 200 || /[\r\n\0]/.test(p.prefix))
      )
        errors.push({ path: "credentialPlacement.prefix", rule: "header-value" });
      return {
        kind: "header",
        name: typeof name === "string" ? name : "",
        ...(typeof p.prefix === "string" ? { prefix: p.prefix } : {}),
      };
    }
    case "query": {
      const name = p.name;
      if (typeof name !== "string" || name.length < 1 || name.length > 200)
        errors.push({ path: "credentialPlacement.name", rule: "printable:1-200" });
      if (p.prefix !== undefined)
        errors.push({ path: "credentialPlacement.prefix", rule: "not-used-by-kind" });
      return { kind: "query", name: typeof name === "string" ? name : "" };
    }
    default:
      errors.push({ path: "credentialPlacement.kind", rule: "one-of:bearer|header|query" });
      return { kind: "bearer" };
  }
}

function stringList(
  value: unknown,
  path: string,
  errors: FieldError[],
  item: (v: string) => boolean,
  rule: string,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ path, rule: "type:array" });
    return [];
  }
  const out: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || !item(entry)) errors.push({ path: `${path}.${index}`, rule });
    else if (out.includes(entry)) errors.push({ path: `${path}.${index}`, rule: "unique" });
    else out.push(entry);
  });
  return out;
}

/**
 * Validates a whole definition. Preset defaults fill fields the operator left out.
 * Every failing field is reported with the rule it broke; no value is echoed.
 */
export function validateDefinition(
  raw: unknown,
  context: ValidationContext,
): { definition: DefinitionInput; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const given =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  if (!given) errors.push({ path: "", rule: "type:object" });
  const input = { ...(given ?? {}) };
  errors.push(...unknownKeyErrors(input, new Set(FIELDS)));

  const typeName = input.type;
  let type: ProviderType | undefined;
  if (typeof typeName !== "string" || !(type = context.types.get(typeName)))
    errors.push({ path: "type", rule: `one-of:${context.types.names().join("|")}` });
  if (type?.defaults) {
    for (const [key, value] of Object.entries(type.defaults(input)))
      if (input[key] === undefined) input[key] = value;
  }

  const id = input.id;
  if (typeof id !== "string" || !SLUG.test(id))
    errors.push({ path: "id", rule: "slug:a-z0-9-,1-63" });
  const displayName = input.displayName;
  if (
    typeof displayName !== "string" ||
    displayName.length < 1 ||
    displayName.length > 200 ||
    !PRINTABLE.test(displayName)
  )
    errors.push({ path: "displayName", rule: "printable:1-200" });
  const ownership = input.ownership;
  if (ownership !== "shared" && ownership !== "personal")
    errors.push({ path: "ownership", rule: "one-of:shared|personal" });

  let apiHosts: string[] = [];
  if (!Array.isArray(input.apiHosts) || input.apiHosts.length === 0)
    errors.push({ path: "apiHosts", rule: "min:1" });
  else {
    input.apiHosts.forEach((entry, index) => {
      const host = normalizeApiHost(entry);
      if (!host) errors.push({ path: `apiHosts.${index}`, rule: "https-base-url" });
      else if (apiHosts.includes(host)) errors.push({ path: `apiHosts.${index}`, rule: "unique" });
      else apiHosts.push(host);
    });
  }
  if (apiHosts.length > 50) {
    errors.push({ path: "apiHosts", rule: "max:50" });
    apiHosts = apiHosts.slice(0, 50);
  }

  const oauthMode = type?.oauth ?? "none";
  const oauth = oauthMode !== "none" && (oauthMode === "required" || input.clientId !== undefined);
  const endpoint = (field: "authorizationEndpoint" | "tokenEndpoint"): string | undefined => {
    const value = input[field];
    if (oauthMode === "none") {
      if (value !== undefined) errors.push({ path: field, rule: "not-used-by-type" });
      return undefined;
    }
    if (!oauth && value === undefined) return undefined;
    const href = httpsUrl(value, true);
    if (!href) errors.push({ path: field, rule: value === undefined ? "required" : "https-url" });
    return href;
  };
  const authorizationEndpoint = endpoint("authorizationEndpoint");
  const tokenEndpoint = endpoint("tokenEndpoint");

  let clientId: string | undefined;
  if (oauthMode === "none") {
    if (input.clientId !== undefined) errors.push({ path: "clientId", rule: "not-used-by-type" });
  } else if (!oauth) {
    // An optional-OAuth preset without a client ID takes static credentials only.
  } else if (
    typeof input.clientId !== "string" ||
    input.clientId.length < 1 ||
    input.clientId.length > 500 ||
    !PRINTABLE.test(input.clientId)
  )
    errors.push({
      path: "clientId",
      rule: input.clientId === undefined ? "required" : "printable:1-500",
    });
  else clientId = input.clientId;

  let tokenAuthentication: "basic" | "post" | undefined;
  if (!oauth) {
    if (input.tokenAuthentication !== undefined && oauthMode === "none")
      errors.push({ path: "tokenAuthentication", rule: "not-used-by-type" });
  } else if (input.tokenAuthentication === undefined) tokenAuthentication = "basic";
  else if (input.tokenAuthentication === "basic" || input.tokenAuthentication === "post")
    tokenAuthentication = input.tokenAuthentication;
  else errors.push({ path: "tokenAuthentication", rule: "one-of:basic|post" });

  const scopes = stringList(
    input.scopes,
    "scopes",
    errors,
    (s) => s.length > 0 && s.length <= 500 && /^[\x21-\x7e]+$/.test(s),
    "scope-token",
  );
  if (oauthMode === "none" && scopes.length)
    errors.push({ path: "scopes", rule: "not-used-by-type" });

  let presetOptions: Record<string, unknown> = {};
  if (input.presetOptions !== undefined) {
    if (
      !input.presetOptions ||
      typeof input.presetOptions !== "object" ||
      Array.isArray(input.presetOptions)
    )
      errors.push({ path: "presetOptions", rule: "type:object" });
    else presetOptions = input.presetOptions as Record<string, unknown>;
  }
  if (type && ["oauth2", "static", "none"].includes(type.name))
    for (const key of Object.keys(presetOptions))
      errors.push({ path: `presetOptions.${key}`, rule: "not-used-by-type" });

  const credentialPlacement = placement(input.credentialPlacement, errors);
  if (type?.credentialless && input.credentialPlacement !== undefined)
    errors.push({ path: "credentialPlacement", rule: "not-used-by-type" });

  const audience = stringList(
    input.audience,
    "audience",
    errors,
    (s) => context.siteIds.has(s),
    "trusted-site",
  );
  if (input.audience === undefined) errors.push({ path: "audience", rule: "required" });

  let reauthorizationInterval: number | undefined;
  const interval = input.reauthorizationInterval;
  if (interval !== undefined && interval !== null) {
    if (
      typeof interval !== "number" ||
      !Number.isSafeInteger(interval) ||
      interval < 60 ||
      interval > 10 * 365 * 86400
    )
      errors.push({ path: "reauthorizationInterval", rule: "seconds:60-315360000" });
    else reauthorizationInterval = interval;
  }

  const bool = (field: "privateHosts" | "enabled", fallback: boolean): boolean => {
    const value = input[field];
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") {
      errors.push({ path: field, rule: "type:boolean" });
      return fallback;
    }
    return value;
  };

  const definition: DefinitionInput = {
    id: typeof id === "string" ? id : "",
    displayName: typeof displayName === "string" ? displayName : "",
    type: typeof typeName === "string" ? typeName : "",
    ownership: ownership === "personal" ? "personal" : "shared",
    apiHosts,
    ...(authorizationEndpoint ? { authorizationEndpoint } : {}),
    ...(tokenEndpoint ? { tokenEndpoint } : {}),
    ...(clientId ? { clientId } : {}),
    ...(tokenAuthentication ? { tokenAuthentication } : {}),
    scopes,
    presetOptions,
    credentialPlacement,
    audience,
    ...(reauthorizationInterval !== undefined ? { reauthorizationInterval } : {}),
    privateHosts: bool("privateHosts", false),
    enabled: bool("enabled", true),
  };
  if (type?.validate)
    errors.push(...type.validate({ ...definition, generation: 1, retired: false }));
  return { definition, errors };
}
