export type Ownership = "shared" | "personal";
export type Placement =
  | { kind: "bearer" }
  | { kind: "header"; name: string; prefix?: string }
  | { kind: "query"; name: string }
  | { kind: "basic" };
export type Selector = string[];
export type Predicate =
  | { path: Selector; equals: string | number | boolean | null }
  | { path: Selector; exists: boolean };
export type ResponseRules = {
  successStatuses: number[];
  success?: Predicate[];
  failure?: Predicate[];
  rejectedGrant?: Predicate[];
};
export type TokenMapping = {
  accessToken: Selector;
  refreshToken?: Selector;
  expiresIn?: Selector;
  scope?: Selector;
  scopeSeparator?: string;
  accountId?: Selector[];
  accountName?: Selector[];
};
export type TokenResponseConfig = {
  format: "json" | "form";
  rules: ResponseRules;
  mapping: TokenMapping;
};
export type ScopeParameter = { name: string; separator: " " | "," };
export type JwtClaims = {
  algorithm: "RS256" | "ES256";
  issuer: string | { credential: "issuer" };
  subject?: string | { credential: "subject" | "issuer" };
  audience: string | { source: "selectedOrigin" };
  scope?: { source: "scopes"; separator: " " | "," };
  keyId?: string | { credential: "keyId" };
  ttlSeconds: number;
};
export type ClientAuthentication =
  | { method: "none"; clientId?: string }
  | { method: "client_secret_basic" | "client_secret_post"; clientId: string }
  | { method: "private_key_jwt"; clientId: string; jwt: JwtClaims };
export type Authentication =
  | {
      method: "authorization_code";
      authorizationEndpoint: string;
      tokenEndpoint: string;
      refreshEndpoint?: string;
      clientAuthentication: ClientAuthentication;
      pkce: "S256" | "none";
      scopeParameter: ScopeParameter;
      authorizeParameters?: Record<string, string>;
      tokenParameters?: Record<string, string>;
      refreshParameters?: Record<string, string>;
      response: TokenResponseConfig;
      refreshResponse?: TokenResponseConfig;
    }
  | {
      method: "client_credentials";
      tokenEndpoint: string;
      clientAuthentication: ClientAuthentication;
      scopeParameter: ScopeParameter;
      tokenParameters?: Record<string, string>;
      response: TokenResponseConfig;
    }
  | {
      method: "jwt_bearer";
      tokenEndpoint: string;
      clientAuthentication: ClientAuthentication;
      jwt: JwtClaims;
      tokenParameters?: Record<string, string>;
      response: TokenResponseConfig;
    }
  | { method: "signed_jwt_direct"; jwt: JwtClaims }
  | { method: "static" }
  | { method: "none" };
export type RequestValue =
  | { literal: string }
  | { source: "accessToken" | "refreshToken" | "clientId" };
export type ProtocolRequest = {
  url: string;
  method: "GET" | "POST" | "DELETE";
  credential: "none" | "accessToken";
  parameters?: Record<string, RequestValue>;
  encoding: "query" | "form" | "json";
  response: ResponseRules;
};
export type AccountLookup = ProtocolRequest & { id: Selector[]; name?: Selector[] };
export type CredentialImport = {
  format: "json";
  fields: { privateKey: Selector; issuer: Selector; subject?: Selector; keyId?: Selector };
  tokenEndpoint?: Selector;
};
export type EventValue = { json: Selector } | { header: string } | { literal: string };
export type Webhook = {
  verification:
    | {
        kind: "hmac";
        algorithm: "sha256";
        header: string;
        prefix: string;
        encoding: "hex" | "base64";
        timestamp?: { header: string; toleranceSeconds: number };
        parts: ({ literal: string } | { timestamp: true } | { rawBody: true })[];
      }
    | {
        kind: "compound-hmac";
        header: string;
        timestampKey: string;
        signatureKey: string;
        separator: string;
        algorithm: "sha256";
        encoding: "hex";
        toleranceSeconds: number;
      }
    | { kind: "body-secret"; batch: Selector; secret: Selector };
  handshake?:
    | {
        kind: "verified-json-echo";
        when: Predicate;
        value: Selector;
        response: "json" | "text";
        responseKey?: string;
      }
    | { kind: "query-echo"; parameter: string; response: "text" };
  event: {
    batch?: Selector;
    id?: EventValue;
    type: EventValue;
    account: EventValue[];
    payload?: Selector;
    omit?: Selector[];
  };
};
export type Definition = {
  id: string;
  displayName: string;
  ownership: Ownership;
  apiHosts: string[];
  credentialPlacement: Placement;
  authentication: Authentication;
  audience: string[];
  scopes: string[];
  reauthorizationInterval?: number;
  privateHosts: boolean;
  enabled: boolean;
  accountLookup?: AccountLookup;
  revocation?: ProtocolRequest;
  webhook?: Webhook;
  credentialImport?: CredentialImport;
};
export type SecretField = "clientSecret" | "signingSecret" | "signingPrivateKey";
export type SecretMeta = { set: boolean; setAt: string | null };
export type DefinitionView = Definition & {
  retired: boolean;
  generation: number;
  version: number;
  secrets: Record<SecretField, SecretMeta>;
  credential: SecretMeta;
  setup: SetupView;
  connectionCounts: { connected: number; needsAuthorization: number; disconnected: number };
};
export type CredentialInput =
  | { kind: "token"; value: string }
  | { kind: "basic"; username: string; password: string }
  | { kind: "jwt"; privateKey: string; issuer: string; subject?: string; keyId?: string }
  | { kind: "import"; value: string };
export type DefinitionWrite = Definition & {
  secrets?: Partial<Record<SecretField, string | null>>;
  credential?: CredentialInput | null;
};
export type CatalogTemplate = {
  id: string;
  name: string;
  description: string;
  definition: Partial<Definition>;
};
export type SetupView = {
  state: "ready" | "needs-setup" | "disabled" | "retired";
  missing: string[];
  actions: ("connect" | "set-credential" | "set-secrets")[];
};
export type OperatorSessionView = {
  operator: { displayName: string };
  expiresAt: string;
  csrfToken: string;
};
export type Observation<T> = {
  state: "ok" | "disabled" | "unavailable" | "stale" | "unknown";
  observedAt: string | null;
  value: T | null;
};
export type StatusView = {
  observedAt: string;
  version: string;
  revision: number;
  readiness: Observation<{ ready: boolean }>;
  database: Observation<{ reachable: boolean }>;
  events: Observation<{ connected: boolean }>;
  processes: {
    instanceId: string;
    role: "api" | "worker";
    startedAt: string;
    lastHeartbeatAt: string;
    state: "ok" | "stale";
    uptimeSeconds: number;
  }[];
  connections: Observation<Record<"connected" | "needs-authorization" | "disconnected", number>>;
  jobs: Observation<Record<string, number>>;
  activity: Observation<{ windowSeconds: 900; activeSessions: number; activeApps: number }>;
};
export type Histogram = { upperBoundsMs: (number | null)[]; counts: number[] };
export type MetricTotals = {
  requests: number;
  errors: number;
  upstreamSamples: number;
  upstreamHistogram: Histogram;
  upstreamP50Ms: number | null;
  upstreamP95Ms: number | null;
  refreshFailures: number;
  exchangeFailures: number;
};
export type MetricSeries = MetricTotals & {
  minute: string;
  definitionId: string;
  status: number | "transport-error" | "cancelled" | "service-error";
};
export type MetricsView = {
  from: string;
  to: string;
  observedAt: string;
  flushedThrough: string | null;
  mayBeIncomplete: boolean;
  series: MetricSeries[];
  totals: MetricTotals;
};
export type AuditEntry = {
  id: string;
  at: string;
  action: string;
  actor: string;
  subject: string | null;
  detail: Record<string, unknown>;
};
