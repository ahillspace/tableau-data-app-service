# Provider protocol data

The connections component owns this finite configuration language.
Authentication acquisition, client authentication and native credential placement are independent.
The schema validates data at definition creation and redefinition; it never evaluates operator-authored code.

## Typed protocol data

```ts
type Selector = string[]; // own JSON object properties only, no expressions
type Scalar = string | number | boolean | null;
type Predicate = { path: Selector; equals: Scalar } | { path: Selector; exists: boolean };
type ResponseRules = {
  successStatuses: number[];
  success?: Predicate[]; // all must pass
  failure?: Predicate[]; // any matches means failure, even on HTTP 200
  rejectedGrant?: Predicate[];
};
type TokenMapping = {
  accessToken: Selector; refreshToken?: Selector; expiresIn?: Selector;
  scope?: Selector; scopeSeparator?: string;
  accountId?: Selector[]; accountName?: Selector[]; // first nonempty string, at most 4
};
type TokenResponse = { format: "json" | "form"; rules: ResponseRules; mapping: TokenMapping };
type ScopeParameter = { name: string; separator: " " | "," };
type JwtClaims = {
  algorithm: "RS256" | "ES256";
  issuer: string | { credential: "issuer" };
  subject?: string | { credential: "subject" | "issuer" };
  audience: string | { source: "selectedOrigin" };
  scope?: { source: "scopes"; separator: " " | "," };
  keyId?: string | { credential: "keyId" };
  ttlSeconds: number; // 1..3600
};
type ClientAuthentication = { method: "none"; clientId?: string }
  | { method: "client_secret_basic" | "client_secret_post"; clientId: string }
  | { method: "private_key_jwt"; clientId: string; jwt: JwtClaims };
type Authentication =
  | { method: "authorization_code"; authorizationEndpoint: string; tokenEndpoint: string;
      refreshEndpoint?: string; clientAuthentication: ClientAuthentication;
      pkce: "S256" | "none"; scopeParameter: ScopeParameter;
      authorizeParameters?: Record<string,string>; tokenParameters?: Record<string,string>;
      refreshParameters?: Record<string,string>;
      response: TokenResponse; refreshResponse?: TokenResponse }
  | { method: "client_credentials"; tokenEndpoint: string;
      clientAuthentication: ClientAuthentication; scopeParameter: ScopeParameter;
      tokenParameters?: Record<string,string>; response: TokenResponse }
  | { method: "jwt_bearer"; tokenEndpoint: string;
      clientAuthentication: ClientAuthentication; jwt: JwtClaims;
      tokenParameters?: Record<string,string>; response: TokenResponse }
  | { method: "signed_jwt_direct"; jwt: JwtClaims }
  | { method: "static" }
  | { method: "none" };
```

Selectors have at most 8 nonempty segments of at most 128 characters and refuse prototype-related property names.
Client identity has one source, `clientAuthentication.clientId`; authorization_code requires it even when client authentication is none.
Authorization, token and private_key_jwt client assertions derive their client identity from that one value.
A private_key_jwt configuration must name that same client ID as issuer and, when supplied, subject; the engine always emits both claims from clientAuthentication.clientId.
Predicates are flat, at most 8 per list, with no regex, recursion, function evaluation or operator nesting.
Extra parameter maps have at most 32 literal entries and cannot override engine-owned grant_type, state, code, redirect_uri, PKCE, assertion or client authentication fields.
The engine creates fixed protocol substitutions for code, redirect URI, verifier, refresh token and assertions; templates cannot execute code.
Refresh response mappings default to the initial mapping but may differ explicitly, as Slack user rotation requires.
Missing optional refresh token retains the existing refresh token; missing or malformed required access token makes the exchange fail safely.
Expiry is positive seconds from response receipt and is checked for finite safe arithmetic.
Account selectors may fall back from team to enterprise without introducing a general coalesce expression.
Protocol response bodies are bounded to 1 MiB, and credential exchange remains bounded to 30 seconds.
The JWT engine emits iat/exp itself and a fresh jti for private_key_jwt, using maintained libraries already present or Node/WebCrypto primitives.
Reject algorithm/key mismatch, insecure algorithms, unsupported header fields and excessive TTL.
Private_key_jwt uses the definition's signingPrivateKey and literal client claims; it cannot reference connection credential fields or a selected native origin.
JWT bearer uses `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` and `assertion`, while private_key_jwt uses `client_assertion_type` and `client_assertion` independently.
Signed_jwt_direct has no token endpoint and places its JWT on the native request.
Only signed_jwt_direct permits selectedOrigin as audience; JWT bearer and private_key_jwt use an explicit configured audience.
Static Basic placement takes a structured username/password credential and encodes it once according to HTTP Basic rules.
Refresh/exchange uses the existing honest `upstream: not-sent | may-have-been-sent` classification, with `refresh-uncertain` or `exchange-uncertain` after an ambiguous send.
Do not automatically replay the business request or claim that an uncertain credential exchange was refused.

## Catalog and import

```ts
type CredentialImport = {
  format: "json";
  fields: { privateKey: Selector; issuer: Selector; subject?: Selector; keyId?: Selector };
  tokenEndpoint?: Selector; // compare with authentication.tokenEndpoint, never adopt
};
type CatalogTemplate = {
  id: string; name: string; description: string;
  definition: Partial<Definition>;
};
```

`GET /v1/admin/catalog` returns `{templates: CatalogTemplate[]}` and never executable hooks or secrets.
Templates are Slack bot, Slack user, Google service account, generic API key and generic OAuth 2.0.
The console selects a template locally and submits an ordinary independent DefinitionWrite.
Required empty properties are completed by the operator before submission.
No template stores real account, tenant, deployment, endpoint override, audience site or credential data.
The Google template selects client_email, private_key and private_key_id from JSON and compares token_uri against its configured token endpoint after strict HTTPS URL normalization.
Reject missing expected token_uri, mismatch, URL credentials, fragments and unsupported source fields used as destinations.
An imported URL never becomes an outbound destination.
Slack bot/user templates carry scope parameter differences, nested initial user token mapping, independent refresh mappings, HTTP-200 failure predicates, lookup, revoke and webhook data.
Static Slack tokens use a static definition with Slack host and webhook defaults, not optional OAuth behavior hidden behind a missing client ID.

## Account lookup and revocation

```ts
type RequestValue = { literal: string } | { source: "accessToken" | "refreshToken" | "clientId" };
type ProtocolRequest = {
  url: string; method: "GET" | "POST" | "DELETE";
  credential: "none" | "accessToken";
  parameters?: Record<string,RequestValue>;
  encoding: "query" | "form" | "json";
  response: ResponseRules;
};
type AccountLookup = ProtocolRequest & { id: Selector[]; name?: Selector[] };
```

URLs are fixed explicit HTTPS endpoints, validated as definition data and executed through shared outbound transport.
Request credential placement follows the definition and parameters use only the three named sources above.
Lookup failure is informational and never discards an otherwise valid connection.
Disconnect ends local authority and deletes the credential regardless of remote revocation success.
Revoke failure is recorded with a stable safe code and never restores the connection.
Do not hold a database transaction open merely for informational lookup or post-disconnect revoke.

## Host patterns

Accept exact HTTPS base URLs and one wildcard within the leftmost DNS label, such as `https://*-aiplatform.googleapis.com`.
The wildcard matches one or more DNS-label characters and never crosses a dot; reject patterns in other labels or multiple wildcards.
Normalize URL hostname, default port and path; reject credentials, query, fragment and encoded path traversal.
Host matching retains the scheme, effective port and path segment boundary, so `/api` does not match `/apix`.
An app selects a concrete configured base URL or a concrete matching origin/base URL through Tableau-Service-Host.
An absent selector uses the first exact configured host; if there is no exact entry, return `host-selection-required`.
A wildcard string itself is never a default or an outbound address.
The exact global Google host is a separate entry from the regional wildcard.
Keep socket-time private/metadata address checks, verified TLS and returned redirects for every transport path.

## Inbound verification

Webhook data consists of a finite verifier, optional handshake and an event mapping.
The engine supports these verifier primitives rather than provider names in routing:

| Primitive | Required configuration | Bytes and matching |
| --- | --- | --- |
| `hmac` | Algorithm sha256, signature header, prefix, encoding hex/base64, optional timestamp header and tolerance, signed parts | Ordered parts are literal UTF-8 bytes, raw timestamp bytes and original body bytes; decoded signatures compare in constant time. |
| `compound-hmac` | Header name, timestamp key, signature key, separator, sha256, hex encoding, tolerance | Parse repeated signature keys, reject ambiguous timestamp values, construct timestamp + literal separator + raw body, accept any matching current signature. |
| `body-secret` | Batch selector and per-item secret selector | Constant-time compare each item with signingSecret, then remove that field from every delivered item. |

Signed parts are an array of at most 5 `{literal:string}`, `{timestamp:true}` or `{rawBody:true}` values, not a string template language.
Timestamps are strict epoch seconds and tolerance checks both old and far-future values.
No timestamp is required when the protocol does not supply one.
The handshake union is `verified-json-echo` with a predicate/path and `query-echo` with a parameter and plain-text response.
A query echo is a protocol handshake only, runs before business verification, emits no event and uses `text/plain; charset=utf-8`, no-store and nosniff.
Event mapping uses bounded selectors for event ID/type/account, optional first-present account selectors and optional one-level batch iteration of at most 1000 items.
No nested event loops or arbitrary payload transforms exist.
Strip the configured body-secret field and known verification-only envelope fields before event payload fan-out and never log a raw webhook body.
Slack data uses v0 timestamp/raw-body HMAC and a verified JSON challenge.
GitHub data uses X-Hub-Signature-256 raw-body HMAC with sha256= and no invented timestamp.
Stripe data uses Stripe-Signature t/v1 members, repeated v1 values and timestamp-dot-raw-body HMAC.
Graph basic data validates each value[].clientState and echoes URL-decoded validationToken as plain text without fan-out.
Graph rich encrypted notifications and automatic subscription lifecycle are unsupported.
Events remain optional lossy Redis/SSE delivery; handshakes must not create deduplication entries or business events.

## Webhook schema

```ts
type EventValue = { json: Selector } | { header: string } | { literal: string };
type Webhook = {
  verification:
    | { kind: "hmac"; algorithm: "sha256"; header: string; prefix: string;
        encoding: "hex" | "base64";
        timestamp?: { header: string; toleranceSeconds: number };
        parts: ({ literal: string } | { timestamp: true } | { rawBody: true })[] }
    | { kind: "compound-hmac"; algorithm: "sha256"; header: string;
        timestampKey: string; signatureKey: string; encoding: "hex";
        separator: string; toleranceSeconds: number }
    | { kind: "body-secret"; batch: Selector; secret: Selector };
  handshake?:
    | { kind: "verified-json-echo"; when: Predicate; value: Selector;
        response: "json" | "text"; responseKey?: string }
    | { kind: "query-echo"; parameter: string; response: "text" };
  event: {
    batch?: Selector; id?: EventValue; type: EventValue;
    account: EventValue[]; payload?: Selector;
    omit?: Selector[];
  };
};
```

Event selectors are relative to each selected batch item and header selectors refer to the original delivery headers.
An absent event ID uses a SHA-256 digest of the verified original bytes plus the batch index, for best-effort duplicate suppression only.
Account alternatives are first-present nonempty strings, bounded to four values.
The engine forcibly strips the configured body-secret path before fan-out even if event.omit is absent, and configured omit has at most eight paths.
Handshake responses are 200 with the selected content type; JSON echo requires a responseKey, while query echo is text-only.
All configured locations/names are validated with bounded lengths; malformed or excessive batches fail before any item is published.


## Protocol references and limits

The JWT bearer grant and JWT client authentication use different OAuth parameters, as specified by [RFC 7523](https://datatracker.ietf.org/doc/html/rfc7523).
The service imposes the one-hour TTL limit and finite selectors as its own bounded configuration choices.
Slack verification signs the timestamp and original body with a version prefix, following [Slack request verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/).
GitHub verification signs the original payload without a timestamp, following [GitHub delivery validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
Stripe's official [webhook implementation](https://github.com/stripe/stripe-node/blob/master/src/Webhooks.ts) establishes timestamp-dot-body signing and repeated signature handling.
Graph basic notification validation and plain-text token echo follow [Microsoft's webhook delivery contract](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks).
These references establish protocol facts, not proof that an installation has passed live provider acceptance.

## Failure, recovery and extension

Malformed mappings, unsupported methods and invalid destinations are rejected before persistence.
An uncertain token operation keeps its uncertainty and cannot authorize a replay of business work.
Missing webhook verification material refuses event ingress without affecting native credential checkout.
A provider using these primitives needs template data only.
A genuinely new authentication or verification protocol adds one shared implementation and representative production-path tests.
