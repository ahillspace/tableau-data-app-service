import { createPrivateKey, type KeyObject, randomUUID, sign } from "node:crypto";
import type { Readable } from "node:stream";
import { invalid, ServiceError } from "../platform/errors.ts";
import type { Outbound } from "../platform/outbound.ts";
import { fieldErrors } from "../platform/validation.ts";
import type { Account } from "./extensions.ts";
import { firstText, matches, select } from "./selectors.ts";
import { leaseFor } from "./store.ts";
import type {
  ConnectionDefinition,
  CredentialInput,
  JwtClaims,
  ProtocolRequest,
  ResponseRules,
  StoredCredential,
  TokenResponseConfig,
} from "./types.ts";
import { credentialSchema } from "./validation.ts";

export function signingKey(pem: string, algorithm?: JwtClaims["algorithm"]): KeyObject {
  try {
    const key = createPrivateKey(pem);
    const rsa =
      key.asymmetricKeyType === "rsa" && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048;
    const ec =
      key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1";
    if (
      (!algorithm && !rsa && !ec) ||
      (algorithm === "RS256" && !rsa) ||
      (algorithm === "ES256" && !ec)
    )
      throw new Error();
    return key;
  } catch {
    throw invalid([{ path: "privateKey", rule: "supported-signing-key" }]);
  }
}

export function normalizeCredential(
  definition: ConnectionDefinition,
  raw: unknown,
): Exclude<CredentialInput, { kind: "import" }> {
  const parsed = credentialSchema.safeParse(raw);
  if (!parsed.success) throw invalid(fieldErrors(parsed.error, "credential"));
  let input = parsed.data;
  if (input.kind === "import") {
    const mapping = definition.credentialImport;
    if (!mapping) throw invalid([{ path: "credential.kind", rule: "import-not-configured" }]);
    let json: unknown;
    try {
      json = JSON.parse(input.value);
    } catch {
      throw invalid([{ path: "credential", rule: "json" }]);
    }
    if (mapping.tokenEndpoint) {
      const endpoint = select(json, mapping.tokenEndpoint);
      let url: URL;
      try {
        url = new URL(typeof endpoint === "string" ? endpoint : "");
      } catch {
        throw invalid([{ path: "credential", rule: "configured-token-endpoint" }]);
      }
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        !("tokenEndpoint" in definition.authentication) ||
        url.href !== definition.authentication.tokenEndpoint
      )
        throw invalid([{ path: "credential", rule: "configured-token-endpoint" }]);
    }
    const fields = Object.fromEntries(
      Object.entries(mapping.fields).map(([key, path]) => [key, select(json, path)]),
    );
    const imported = credentialSchema.safeParse({ kind: "jwt", ...fields });
    if (!imported.success || imported.data.kind !== "jwt")
      throw invalid([{ path: "credential", rule: "import-fields" }]);
    input = imported.data;
  }
  const method = definition.authentication.method;
  if (method === "static") {
    const basic = definition.credentialPlacement.kind === "basic";
    if (input.kind !== (basic ? "basic" : "token"))
      throw invalid([{ path: "credential.kind", rule: basic ? "basic" : "token" }]);
    if (
      input.kind === "token" &&
      definition.credentialPlacement.kind !== "query" &&
      /[\r\n\0]/.test(input.value)
    )
      throw invalid([{ path: "credential.value", rule: "header-safe" }]);
  } else if (method === "jwt_bearer" || method === "signed_jwt_direct") {
    if (input.kind !== "jwt") throw invalid([{ path: "credential.kind", rule: "jwt" }]);
    signingKey(input.privateKey, definition.authentication.jwt.algorithm);
    const subject = definition.authentication.jwt.subject;
    if (typeof subject === "object" && subject.credential === "subject" && !input.subject)
      throw invalid([{ path: "credential.subject", rule: "required" }]);
  } else throw invalid([{ path: "credential", rule: "method-has-no-input-credential" }]);
  return input as Exclude<CredentialInput, { kind: "import" }>;
}

export function createJwt(
  config: JwtClaims,
  privateKey: string,
  credential: Extract<CredentialInput, { kind: "jwt" }> | undefined,
  scopes: string[],
  selectedOrigin: string | undefined,
  now: Date,
  clientAssertion = false,
): string {
  const field = (
    value: string | { credential: "issuer" | "subject" | "keyId" } | undefined,
  ): string | undefined =>
    typeof value === "string" ? value : value ? credential?.[value.credential] : undefined;
  const issuer = field(config.issuer),
    subject = field(config.subject),
    keyId = field(config.keyId);
  const audience = typeof config.audience === "string" ? config.audience : selectedOrigin;
  if (!issuer || !audience || (config.subject !== undefined && !subject))
    throw new ServiceError(409, "credential-incomplete", "JWT claims need credential metadata", {
      upstream: "not-sent",
    });
  const iat = Math.floor(now.getTime() / 1000);
  const header = { alg: config.algorithm, typ: "JWT", ...(keyId ? { kid: keyId } : {}) };
  const payload = {
    iss: issuer,
    ...(subject ? { sub: subject } : {}),
    aud: audience,
    iat,
    exp: iat + config.ttlSeconds,
    ...(config.scope ? { scope: scopes.join(config.scope.separator) } : {}),
    ...(clientAssertion ? { jti: randomUUID() } : {}),
  };
  const signingInput = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: signingKey(privateKey, config.algorithm),
    ...(config.algorithm === "ES256" ? { dsaEncoding: "ieee-p1363" as const } : {}),
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

async function readBody(body: Readable, format: "json" | "form"): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 1024 * 1024) {
        body.destroy();
        throw new Error();
      }
      chunks.push(bytes);
    }
  } catch {
    throw new ServiceError(
      502,
      "protocol-response-interrupted",
      "The provider response did not complete",
      { upstream: "may-have-been-sent" },
    );
  }
  try {
    const text = Buffer.concat(chunks).toString("utf8");
    return format === "json" ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text));
  } catch {
    return null;
  }
}
export function responseAccepted(status: number, body: unknown, rules: ResponseRules): boolean {
  return (
    rules.successStatuses.includes(status) &&
    (rules.success ?? []).every((p) => matches(body, p)) &&
    !(rules.failure ?? []).some((p) => matches(body, p))
  );
}
export type TokenReading =
  | {
      kind: "ok";
      credential: StoredCredential;
      account: Account | null;
      scopes: string[] | undefined;
    }
  | { kind: "error"; definitive: boolean; rejectsGrant: boolean };
export function readTokens(
  config: TokenResponseConfig,
  response: { status: number; body: unknown },
  now: Date,
): TokenReading {
  const { status, body } = response;
  const refused = (config.rules.failure ?? []).some((p) => matches(body, p));
  if (!responseAccepted(status, body, config.rules))
    return {
      kind: "error",
      definitive: status < 500 && status !== 429 && ((status >= 400 && status < 500) || refused),
      rejectsGrant:
        (config.rules.rejectedGrant ?? []).some((p) => matches(body, p)) &&
        status < 500 &&
        status !== 429,
    };
  const m = config.mapping,
    accessToken = select(body, m.accessToken);
  if (
    typeof accessToken !== "string" ||
    !accessToken ||
    /[\r\n\0]/.test(accessToken) ||
    Buffer.byteLength(accessToken) > 65536
  )
    return { kind: "error", definitive: false, rejectsGrant: false };
  const refresh = m.refreshToken ? select(body, m.refreshToken) : undefined;
  if (
    refresh !== undefined &&
    (typeof refresh !== "string" || !refresh || Buffer.byteLength(refresh) > 65536)
  )
    return { kind: "error", definitive: false, rejectsGrant: false };
  const expiry = m.expiresIn ? select(body, m.expiresIn) : undefined;
  const seconds = typeof expiry === "string" || typeof expiry === "number" ? Number(expiry) : NaN;
  const expiresAt = now.getTime() + seconds * 1000;
  if (
    expiry !== undefined &&
    (!Number.isFinite(seconds) ||
      seconds <= 0 ||
      !Number.isSafeInteger(Math.ceil(expiresAt)) ||
      expiresAt > 8.64e15)
  )
    return { kind: "error", definitive: false, rejectsGrant: false };
  const scope = m.scope ? select(body, m.scope) : undefined;
  const account = firstText(body, m.accountId);
  return {
    kind: "ok",
    credential: {
      accessToken,
      ...(typeof refresh === "string" ? { refreshToken: refresh } : {}),
      ...(expiry !== undefined ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
    },
    account: account ? { id: account, name: firstText(body, m.accountName) ?? null } : null,
    scopes:
      typeof scope === "string" ? scope.split(m.scopeSeparator ?? " ").filter(Boolean) : undefined,
  };
}

const encode = (value: string) => encodeURIComponent(value).replace(/%20/g, "+");
export async function tokenRequest(
  outbound: Outbound,
  definition: ConnectionDefinition,
  secrets: { clientSecret?: string | undefined; signingPrivateKey?: string | undefined },
  parameters: Record<string, string>,
  refresh: boolean,
  now: Date,
  signal: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  const auth = definition.authentication;
  if (!("tokenEndpoint" in auth))
    throw new ServiceError(409, "token-not-supported", "This method has no token endpoint", {
      upstream: "not-sent",
    });
  const endpoint =
    refresh && auth.method === "authorization_code"
      ? (auth.refreshEndpoint ?? auth.tokenEndpoint)
      : auth.tokenEndpoint;
  const body = new URLSearchParams({
    ...auth.tokenParameters,
    ...(refresh && auth.method === "authorization_code" ? auth.refreshParameters : {}),
    ...parameters,
  });
  const headers: [string, string][] = [
    ["content-type", "application/x-www-form-urlencoded;charset=UTF-8"],
    ["accept", "application/json"],
  ];
  const client = auth.clientAuthentication;
  if (client.method === "client_secret_basic" || client.method === "client_secret_post") {
    if (!secrets.clientSecret)
      throw new ServiceError(409, "credential-incomplete", "The client secret is not set", {
        upstream: "not-sent",
      });
    if (client.method === "client_secret_basic")
      headers.push([
        "authorization",
        `Basic ${Buffer.from(`${encode(client.clientId)}:${encode(secrets.clientSecret)}`).toString("base64")}`,
      ]);
    else {
      body.set("client_id", client.clientId);
      body.set("client_secret", secrets.clientSecret);
    }
  } else {
    if (client.clientId) body.set("client_id", client.clientId);
    if (client.method === "private_key_jwt") {
      if (!secrets.signingPrivateKey)
        throw new ServiceError(409, "credential-incomplete", "The client signing key is not set", {
          upstream: "not-sent",
        });
      body.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
      body.set(
        "client_assertion",
        createJwt(
          { ...client.jwt, issuer: client.clientId, subject: client.clientId },
          secrets.signingPrivateKey,
          undefined,
          definition.scopes,
          undefined,
          now,
          true,
        ),
      );
    }
  }
  const response = await outbound.request(new URL(endpoint), {
    method: "POST",
    headers,
    body: body.toString(),
    signal,
    privateHosts: definition.privateHosts,
  });
  const config =
    refresh && auth.method === "authorization_code"
      ? (auth.refreshResponse ?? auth.response)
      : auth.response;
  return { status: response.status, body: await readBody(response.body, config.format) };
}

export async function configuredRequest(
  outbound: Outbound,
  definition: ConnectionDefinition,
  config: ProtocolRequest,
  credential: StoredCredential,
  signal: AbortSignal,
): Promise<unknown> {
  const url = new URL(config.url),
    parameters: Record<string, string> = {};
  const auth = definition.authentication;
  const sources = {
    accessToken:
      credential.accessToken ??
      (credential.input?.kind === "token" ? credential.input.value : undefined),
    refreshToken: credential.refreshToken,
    clientId: "clientAuthentication" in auth ? auth.clientAuthentication.clientId : undefined,
  };
  for (const [name, value] of Object.entries(config.parameters ?? {})) {
    const resolved = "literal" in value ? value.literal : sources[value.source];
    if (resolved === undefined)
      throw new ServiceError(
        409,
        "protocol-input-missing",
        "A protocol request source is unavailable",
      );
    parameters[name] = resolved;
  }
  let body: string | undefined;
  const headers: [string, string][] = [["accept", "application/json"]];
  if (config.encoding === "query")
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  else if (config.encoding === "form") {
    body = new URLSearchParams(parameters).toString();
    headers.push(["content-type", "application/x-www-form-urlencoded"]);
  } else {
    body = JSON.stringify(parameters);
    headers.push(["content-type", "application/json"]);
  }
  const request = { target: `${url.pathname}${url.search}`, headers };
  if (config.credential === "accessToken") leaseFor(definition, null, credential).apply(request);
  const response = await outbound.request(url, {
    method: config.method,
    rawTarget: request.target,
    headers: request.headers,
    ...(body !== undefined ? { body } : {}),
    signal,
    privateHosts: definition.privateHosts,
  });
  const value = await readBody(response.body, "json");
  if (!responseAccepted(response.status, value, config.response))
    throw new ServiceError(
      502,
      "protocol-request-failed",
      "The provider refused the configured request",
    );
  return value;
}
