# Provider modules and capability execution

Status: proposed module contract.
Provider modules own external behavior; execution owns admission, limits, command identity, effect evidence and recovery.
Neither owner duplicates connection-use authorization.

## Registration and extension

A statically imported provider module registers an ID, versioned configuration schema, supported authorization methods, credential driver, endpoint policy, capability definitions and handlers, and optional event verifier/normalizer.
An operator creates a provider registration containing validated configuration and references to server-side secrets.
A provider registration is distinct from both the provider module and a connected external account.
Apps select a provider registration through their capability configuration.

Startup validation rejects duplicate provider/capability versions, missing handlers, incompatible identity methods, unsatisfied permission declarations, and unsafe or missing limits.
Changing endpoint or client registration configuration creates a new configuration revision.
Connections record the registration revision against which they were authorized; changes that alter issuer, OAuth client or credential meaning require explicit migration or reauthorization.
An operator cannot silently redirect existing credentials to a new endpoint by editing a free-form base URL.

The credential driver implements only supported operations: validate imported material, begin/complete interactive authorization, renew, derive, classify credential rejection, and optionally revoke.
The shared OAuth protocol adapter owns protocol validation and library use; provider hooks supply validated configuration and documented differences.
New authorization behavior may require a new driver or protocol adapter, but it reuses connection ownership, encrypted storage, concurrency and disconnect semantics.

To add a second synthetic provider, register its configuration, driver and endpoints, then add a capability handler and schemas to the registry.
The extension check is that existing handlers, HTTP routes, connection tables and browser connection code require no edits for already supported lifecycle behavior.
No provider-specific switch belongs in the execution service or browser SDK.

## Controlled outbound request seam

```ts
type ProviderRequest = {
  endpoint: string;
  path: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Readonly<Record<string, string>>;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
  effect: "read" | "write";
  stepKey: string;
};

type ProviderResponse = {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: unknown;
};
```

`endpoint` selects an operator-validated endpoint family registered by the provider module.
`path` is a relative provider resource path; absolute URLs, authority replacement, userinfo and traversal outside the permitted prefix are rejected after URL normalization.
Query and headers are schema/allowlist constrained; handlers cannot override credential, host, cookie or forwarding headers.
The transport injects credential authorization after validation, scoped to the selected connection, endpoint audience and required permissions.
It exposes selected safe response headers only.

The outbound owner enforces TLS verification, allowed destinations, address checks at connection time, body/decompression limits, request count, timeout and cancellation.
Redirects are disabled by default.
If a provider needs redirects, each destination is checked and authorization is never forwarded to a different origin without an explicit provider-reviewed audience rule.
DNS checks and the actual connection destination must agree so validation cannot be bypassed by a second uncontrolled lookup.
Private endpoints require explicit operator endpoint policy; the default never grants arbitrary internal-network access.
Token exchange and renewal use the same network protections with their own narrow endpoint rules.

Capability code never receives raw credentials or a public arbitrary-URL proxy.
Reviewed provider adapters can inspect necessary secrets inside their privileged credential/signing hooks, but cannot change the connection's approved execution identity.
This is an architectural discipline for trusted code, not a sandbox guarantee against malicious installed modules.

## Admission and inline execution

1. Verify access, load current app policy, resolve the exact capability version, and validate bounded input.
2. Check for an existing command receipt scoped to app, holder-or-binding ownership and request key before selecting a new connection or dispatching work.
3. If new, resolve the fixed identity and connection, permissions and effective limits, then atomically create the receipt with its command digest, admitted context and supervision deadline.
4. Obtain usable credentials when required, construct a scoped `CapabilityContext`, and run the handler inline.
5. Before each provider request, revalidate access, current app policy and connection epoch, and account for request budget.
6. Before the first write can leave the process, commit its dispatch marker; execute, classify effect evidence, validate output, and persist the terminal receipt.
7. Recheck disclosure authority, then return the permitted result.

The command digest covers canonical validated input, capability version and caller connection selection.
The receipt stores the actual resolved connection, provider registration, app revision, holder/binding owner, and authorization epoch separately.
Duplicate submissions use that original resolution and cannot silently select a replacement connection after configuration changes.
A duplicate must still be authorized to inspect the original receipt.
Equal keys with changed command digests return `request-conflict` without dispatch.
A concurrent equal command returns its pending or terminal receipt, not a second handler.

No external credential is loaded for a `none` capability.
The effective deadline is the minimum of the configured capability limit, service limit and remaining access lifetime.
Capacity and rate limits reject excess work with safe retry guidance; accepted requests are not silently added to a work queue.
The supervision owner and deadline let another process recognize interrupted receipts without pretending to resume the handler.

## Effects, retry and cancellation

The handler's declared effect is checked against every outbound request; a read capability cannot dispatch a write.
HTTP method alone does not establish effect or idempotency.
One capability may make multiple bounded requests, but its handler must describe partial failure and any known applied effect.
The service does not automatically compensate, roll back remote writes, or resume from an intermediate step.
An interrupted multi-request write is uncertain unless provider evidence establishes its complete outcome.

`safe-read` retries only requests whose adapter guarantees no mutation.
`provider-key` retries a write only with a stable provider key derived from the invocation ID and deterministic `stepKey`, identical request content, and within the provider's documented key lifetime.
The handler must supply stable step keys and declare when different steps have independent effects.
Unknown provider idempotency behavior means `never`.
Retry policy applies at the outbound request boundary; the core never blindly reruns an entire handler after a partial effect.
Attempts use bounded backoff, respect trustworthy retry delay information, and remain inside the operation deadline and request-count limit.
An authentication rejection may trigger credential repair, but does not automatically make the business request safe to replay.

A failed request known not to have left the process has `effect: none`.
A timeout, reset, cancellation or process loss after write admission may have changed the provider and has `effect: unknown` unless stronger evidence exists.
A definitive rejection is no effect only when the provider adapter can justify that conclusion for the operation.
Success at the provider followed by response-schema failure has `effect: applied`, not a retryable validation failure.
When earlier steps succeeded and a later step definitively failed, return a partial-effect result with a safe reconciliation description.

Browser abort requests cancellation through the HTTP adapter and `AbortSignal`.
The transport stops undispatched work and attempts to abort active network requests; it does not claim remote cancellation succeeded.
The service still records the best-known receipt after the browser has gone away.
The caller uses its request key or invocation ID to inspect the result after a lost response.
Cancellation before any write admission can finish as `failed/cancelled` with no effect.
Cancellation after write admission preserves uncertain or applied effect evidence.

On restart, an abandoned receipt with no write dispatch marker becomes a failed interrupted operation with no write effect.
An abandoned receipt with a write marker becomes uncertain.
The service never automatically executes the original command again after restart.
An optional provider reconciliation hook may inspect remote status using the original operation key and current authority, then conditionally refine the receipt.
If no such hook exists, expose uncertainty and the capability's documented manual check; do not invent exactly-once behavior.

## Result retention and paging

Bounded outputs are encrypted in receipt storage only for the configured replay interval.
The receipt advertises that interval and retains a compact command tombstone beyond output expiry according to operator policy.
An expired output returns `result-expired`; the same request key does not become a new write while its tombstone remains.
The SDK must not retry old writes after the advertised command retention horizon.
The service cannot provide duplicate suppression after that state is deliberately deleted.
Retention defaults must be chosen before implementation acceptance and exposed to clients.

A paginated read returns the shared `Page<T>` shape and fetches one bounded page per invocation.
The handler translates the provider cursor, offset or page link; the browser sees a service-owned opaque cursor.
The cursor is authenticated and encrypted where it contains provider state, and binds app, holder/binding, capability version, resolved connection/epoch, query digest, page size and expiry.
A cursor is not authority and is rejected under a different access context or query.
Provider next-page links still pass endpoint validation.
Changing permission or connection epoch invalidates old cursors.
No stable snapshot across pages is promised unless the provider contract supports one; the capability describes live-page duplicates or omissions and any snapshot token.
