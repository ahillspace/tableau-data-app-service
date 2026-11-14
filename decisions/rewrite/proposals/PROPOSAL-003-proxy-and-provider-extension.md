# PROPOSAL-003: Native proxy access and small provider modules

Status: new architecture recommendation for user review, grounded in REWRITE-002, REWRITE-006, REWRITE-009, and REWRITE-010.
Recorded: 2026-11-08.

## Recommendation and why

Expose a bounded HTTP proxy addressed by provider registration, approved endpoint family, relative native path, method, native query, selected headers, and raw request body.
The SDK supplies service authentication and connection selection separately from provider request data.
Return native provider status, supported response headers, and body rather than wrapping every response in a capability result.
This leaves API knowledge with the app author while the service owns connection authorization, credential renewal, destination validation, and transport limits.
A provider needs authentication and endpoint configuration to support this path; capability definitions are optional.

Use one routing format, such as `/v1/proxy/:providerRegistration/:endpoint/*`, with a dedicated connection-selection header and native method/query/body.
Reserve and strip service-control headers before forwarding.
The path format is illustrative; the important contract is that the client never supplies an arbitrary destination authority or credential.

## Access policy without per-endpoint handlers

Each app has explicit provider grants specifying permitted identity mode, endpoint families, and allowed methods/path prefixes when restriction is needed.
Default a new grant to no access until configured.
For an app owner's delegated connection, an explicit broad grant over the provider's approved API family is reasonable; the provider still enforces that user's native permissions.
For a shared service connection, require deliberate app binding, viewer/backend audience, and the smallest useful method/path scope before exposing it.
Wildcard service API access is an explicit privileged choice, not the consequence of registering a provider.

These are routing and authorization rules, not a managed capability for every endpoint or a universal provider permission model.
Known granted-scope evidence can prevent a request where it clearly proves missing permission; otherwise let the native provider enforce its operation permissions.
Neither provider scope nor HTTP method alone proves that the app is permitted to use a shared credential.
The connection resolves to `none`, a configured service binding, or the exact authorized delegated owner; there is no identity fallback.

## Forwarding boundaries

Validate normalized destinations against the configured endpoint family before credentials are attached.
Reject absolute-URL or authority replacement, unsupported schemes, userinfo, forbidden path traversal, and unsafe continuation destinations.
Use the same policy for authorization, refresh, ordinary proxy traffic, and backend helpers.
Bind DNS/address validation to the actual outbound connection; explicitly configured internal endpoints are possible, arbitrary internal-network access is not.
Disable redirects by default and require explicit destination-by-destination policy for a provider exception.
Never automatically forward credentials to a different origin.

Strip caller Authorization, Cookie, Host, forwarding, hop-by-hop, and service-control headers before injecting server-owned provider authorization.
Allow useful provider headers such as content type, conditional request headers, and native idempotency keys according to endpoint configuration.
Do not forward provider Set-Cookie or treat provider redirects as application navigation.
Expose selected useful response headers through CORS, including provider request IDs, content disposition, rate limits, and safe native pagination links where applicable.
Do not expose a next-page URL containing credentials or accept it as an unvalidated future destination.

Native provider error bodies may contain sensitive data.
Use a provider route policy to deny credential/token administration endpoints and redact specifically known secret fields when supported without breaking the contract.
An endpoint that can return credentials or cannot be safely exposed is unsupported until reviewed; preserving native responses is not permission to export secrets.
Do not log request/response bodies or raw provider errors.
Distinguish a service-generated routing/auth/transport failure by a reserved service error header and documented error body; do not pretend it came from the provider.

## Uploads, downloads, and streaming

Support bounded JSON, text, and binary bodies, including multipart bytes with their original boundary, without assuming every request is JSON.
Stream uploads and responses with backpressure and measured byte limits; avoid buffering an entire file solely to forward it.
Respect caller cancellation and stop upstream work when practical, while acknowledging that partial uploads or aborted writes may already have remote effects.
If a response exceeds limits after headers were sent, terminate the stream and expose a truncated-transfer error to the SDK; do not rewrite an already-started success response as an intact error document.

Recommend initial defaults of 16 MiB ordinary request/response bodies and a 60-second total request deadline, with explicitly enabled upload/download routes up to 100 MiB and ten minutes.
Treat these values as conservative starting configuration to validate, not measured capacity claims.
Allow finite provider response streams under an explicitly enabled route with an idle timeout and maximum duration/bytes.
Do not claim initial support for WebSocket upgrades, arbitrary bidirectional tunnels, resumable-upload orchestration, or every official browser SDK transport.
Our event SSE endpoint is a separate durable delivery contract.

No proxy request is automatically queued, deduplicated, or replayed after token refresh, an HTTP failure, or a lost response.
Refresh before dispatch when possible; after a provider authentication rejection, repair credentials for the next deliberate attempt and return the original failure.
An explicit later retry option must define ownership and duplicate-effect risk; it is not an initial requirement.

## Provider extension contract

Keep static provider registration with configuration for endpoint families, authorization protocol/client, scopes, token authentication method, and credential expiry semantics.
Use a maintained OAuth library behind the shared protocol adapter; `oauth4webapi` is a candidate because its official API covers code exchange, PKCE, response validation, and refresh primitives: [project API reference](https://github.com/panva/oauth4webapi/blob/main/docs/README.md).
This is a library recommendation to validate and pin during implementation, not copied provider implementation material.

Optional narrow hooks may add reviewed request parameters, parse a documented nonstandard token response, derive provider account/permission evidence, interpret credential rejection, or reconcile an uncertain refresh.
Hooks return data or a declared lifecycle result; they do not write connection records, replace ownership, choose arbitrary destinations, or implement their own refresh locking.
Ordinary endpoint/schema/code changes preserve existing credentials.
Changing issuer, client identity, credential meaning, encryption context, or accepted account semantics requires an explicit compatibility disposition: retain if evidence supports it, migrate with a specific tool, or reconnect.
Do not invalidate connections merely because a module version changes.

For trusted server code, offer a scoped helper and an explicit credential checkout tied to the authorized connection/epoch and bounded execution context.
The custom client may hold the credential only for that operation, must disable its own implicit retries unless intentionally configured, and must honor destination, timeout, cancellation, and logging requirements.
It cannot mutate credential storage or acquire another owner's connection.
Revocation cannot erase a credential already copied into trusted custom code; review and cooperation are necessary, and helper enforcement must not be claimed for that path.

Paging stays native for proxy calls and capability-defined for managed operations.
Optional helpers can validate relative next-page links or store a sensitive bounded continuation behind an owner/connection/query-scoped expiring opaque handle.
Create server-held continuation state only for a capability that needs it, and reject stale handles after connection replacement.
Do not recreate a universal cursor protocol.

## Costs, alternatives, and completion evidence

An arbitrary URL proxy has less configuration but cannot establish where a credential may go.
A capability per endpoint offers tighter typed control but defeats the accepted native-access foundation.
The proposed endpoint family and app grant provide the smallest shared policy while retaining native flexibility.

The rewrite must update discovery to show permitted providers/proxy features as well as optional capabilities, and replace the old no-proxy/no-credential-getter contracts.
Exercise a frontend-only connection and native API call, a restricted service grant, a provider-native page, binary upload/download, finite stream cancellation, secret-returning endpoint rejection, and unsafe redirect/DNS destination.
Add a second synthetic provider through configuration plus one narrow hook and an optional custom SDK handler without editing existing provider logic.
Provider-specific header/body sanitization, actual transport limits, and any unusual SDK/signing integration require concrete provider tests before support is advertised.
