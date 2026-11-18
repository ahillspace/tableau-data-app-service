import type {
  Authentication,
  ClientAuthentication,
  CredentialInput,
  Definition,
  DefinitionView,
  SecretField,
} from "../contracts/operator.ts";

export const METHODS: Authentication["method"][] = [
  "authorization_code",
  "client_credentials",
  "jwt_bearer",
  "signed_jwt_direct",
  "static",
  "none",
];
export const STATE_LABELS = {
  ready: "Ready",
  "needs-setup": "Needs setup",
  disabled: "Disabled",
  retired: "Retired",
};
export const SECRET_LABELS = {
  clientSecret: "Application client secret",
  signingPrivateKey: "Application signing key",
  signingSecret: "Webhook verification secret",
  credential: "Shared connection credential",
};

export class FormError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(message);
    this.path = path;
  }
}

export function defaultAuthentication(method: Authentication["method"]): Authentication {
  const response = {
    format: "json" as const,
    rules: { successStatuses: [200] },
    mapping: {
      accessToken: ["access_token"],
      refreshToken: ["refresh_token"],
      expiresIn: ["expires_in"],
    },
  };
  const jwt = {
    algorithm: "RS256" as const,
    issuer: { credential: "issuer" as const },
    audience: "",
    ttlSeconds: 3600,
  };
  switch (method) {
    case "authorization_code":
      return {
        method,
        authorizationEndpoint: "",
        tokenEndpoint: "",
        clientAuthentication: { method: "client_secret_basic", clientId: "" },
        pkce: "S256",
        scopeParameter: { name: "scope", separator: " " },
        response,
      };
    case "client_credentials":
      return {
        method,
        tokenEndpoint: "",
        clientAuthentication: { method: "client_secret_basic", clientId: "" },
        scopeParameter: { name: "scope", separator: " " },
        response,
      };
    case "jwt_bearer":
      return { method, tokenEndpoint: "", clientAuthentication: { method: "none" }, jwt, response };
    case "signed_jwt_direct":
      return { method, jwt };
    default:
      return { method };
  }
}

export function clientAuthenticationReader(initial: Authentication) {
  const client = "clientAuthentication" in initial ? initial.clientAuthentication : undefined;
  let defaults = {
    issuer: client?.method === "private_key_jwt" && client.jwt.issuer === client.clientId,
    subject: client?.method === "private_key_jwt" && client.jwt.subject === client.clientId,
    audience:
      client?.method === "private_key_jwt" &&
      "tokenEndpoint" in initial &&
      client.jwt.audience === initial.tokenEndpoint,
  };
  return (
    previous: ClientAuthentication,
    fields: { method: ClientAuthentication["method"]; clientId: string; tokenEndpoint: string },
  ): ClientAuthentication => {
    const { method, clientId, tokenEndpoint } = fields;
    if (method === "none") return { method, ...(clientId ? { clientId } : {}) };
    if (method !== "private_key_jwt") return { method, clientId };
    if (previous.method !== "private_key_jwt") {
      defaults = { issuer: true, subject: true, audience: true };
      return {
        method,
        clientId,
        jwt: {
          algorithm: "RS256",
          issuer: clientId,
          subject: clientId,
          audience: tokenEndpoint,
          ttlSeconds: 300,
        },
      };
    }
    const jwt = structuredClone(previous.jwt);
    if (defaults.issuer) jwt.issuer = clientId;
    if (defaults.subject) jwt.subject = clientId;
    if (defaults.audience) jwt.audience = tokenEndpoint;
    return { method, clientId, jwt };
  };
}

export function newDefinition(template: Partial<Definition> = {}): Definition {
  return {
    id: "",
    displayName: "",
    ownership: "shared",
    apiHosts: [],
    credentialPlacement: { kind: "bearer" },
    authentication: { method: "none" },
    audience: [],
    scopes: [],
    privateHosts: false,
    enabled: true,
    ...structuredClone(template),
  };
}

export function editableDefinition(view: DefinitionView): Definition {
  const {
    retired: _r,
    generation: _g,
    version: _v,
    secrets: _s,
    credential: _c,
    setup: _setup,
    connectionCounts: _counts,
    ...definition
  } = view;
  return structuredClone(definition);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

/** Classify the public draft only; secret writes have their own versioned, write-only operation. */
export function definitionChanges(
  before: Definition,
  after: Definition,
): { redefine: boolean; patch: Record<string, unknown> } {
  const patch: Record<string, unknown> = {};
  let redefine = false;
  const inPlace = new Set([
    "displayName",
    "audience",
    "scopes",
    "reauthorizationInterval",
    "enabled",
  ]);
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[key as keyof Definition];
    const b = after[key as keyof Definition];
    if (canonical(a) === canonical(b)) continue;
    if (key === "id") throw new FormError("id", "A definition ID cannot change.");
    patch[key] = b ?? null;
    if (!inPlace.has(key)) redefine = true;
  }
  return { redefine, patch };
}

export function serializeSecret(fields: Record<string, string | boolean>): {
  secrets?: Partial<Record<SecretField, string | null>>;
  credential?: CredentialInput | null;
} {
  const text = (name: string) => (typeof fields[name] === "string" ? (fields[name] as string) : "");
  const destination = text("destination");
  if (!Object.hasOwn(SECRET_LABELS, destination))
    throw new FormError("destination", "Choose a secret destination.");
  const value = text("value");
  const multiline = text("multiline");
  const hasOtherInput = [
    value,
    multiline,
    text("username"),
    text("password"),
    text("issuer"),
    text("subject"),
    text("keyId"),
  ].some(Boolean);
  if (fields.clear === true) {
    if (hasOtherInput)
      throw new FormError("clear", "Choose either a replacement or explicit clearing.");
    return destination === "credential"
      ? { credential: null }
      : { secrets: { [destination]: null } };
  }
  if (value && multiline) throw new FormError("value", "Use one value input.");
  const input = value || multiline;
  if (destination !== "credential") {
    if (!input)
      throw new FormError("value", "Enter a replacement. Blank never clears a stored value.");
    return { secrets: { [destination]: input } };
  }
  switch (text("kind")) {
    case "basic":
      if (!text("username") || !text("password"))
        throw new FormError("credential", "Enter both the Basic username and password.");
      return {
        credential: { kind: "basic", username: text("username"), password: text("password") },
      };
    case "jwt":
      if (!input || !text("issuer"))
        throw new FormError("credential", "Enter a private key and issuer.");
      return {
        credential: {
          kind: "jwt",
          privateKey: input,
          issuer: text("issuer"),
          ...(text("subject") ? { subject: text("subject") } : {}),
          ...(text("keyId") ? { keyId: text("keyId") } : {}),
        },
      };
    case "import":
      if (!input)
        throw new FormError(
          "credential",
          "Enter credential JSON using the configured import mapping.",
        );
      return { credential: { kind: "import", value: input } };
    case "token":
      if (!input) throw new FormError("credential", "Enter a replacement token.");
      return { credential: { kind: "token", value: input } };
    default:
      throw new FormError("credential", "Choose a credential format.");
  }
}
