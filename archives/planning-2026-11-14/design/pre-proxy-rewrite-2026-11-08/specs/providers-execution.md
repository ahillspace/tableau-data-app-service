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

1. Verify access and its recovery generation, load current app policy, resolve the exact capability version, and validate the bounded command envelope and base input.
2. Verify the command-window signature, owner and generation, then check for an existing command receipt scoped to generation, app, holder-or-binding ownership and request key before selecting a new connection or dispatching work.
3. If new, require an open admission interval, resolve fixed identity, connection, permissions, paging and effective limits, then atomically create the receipt with its command digest, original window, admitted context and supervision deadline.
4. Obtain usable credentials when required, construct a scoped `CapabilityContext`, and run the handler inline.
5. Before each provider request, revalidate access, current app policy and connection epoch, and account for request budget.
6. Before the first write can leave the process, commit its dispatch marker; execute, classify effect evidence, validate output, and persist the terminal receipt.
7. Recheck disclosure authority, then return the permitted result.

The command digest covers canonical validated base input, capability version, caller connection selection, page size and the supplied public cursor, if any.
The original command window is stored and must match on resubmission; it is not silently replaced with a newer discovery window.
The receipt stores the actual resolved connection, provider registration, app revision, holder/binding owner, recovery generation and authorization epoch separately.
Duplicate submissions use that original resolution and cannot silently select a replacement connection after configuration changes.
A duplicate must still be authorized to inspect the original receipt and be within its advertised history interval.
Equal keys with changed command digests return `request-conflict` without dispatch.
A concurrent equal command returns its pending or terminal receipt, not a second handler.

No external credential is loaded for a `none` capability.
The effective deadline is the minimum of the configured capability limit, service limit and remaining access lifetime.
Capacity and rate limits reject excess work with safe retry guidance; accepted requests are not silently added to a work queue.
The supervision owner and deadline let another process recognize interrupted receipts without pretending to resume the handler.
Command windows constrain new admission, not completion of an already admitted request within its original execution deadline.

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
The caller uses its retained command window and request key, or its invocation ID, to inspect the result after a lost response.
Cancellation before any write admission can finish as `failed/cancelled` with no effect.
Cancellation after write admission preserves uncertain or applied effect evidence.

On restart, an abandoned receipt with no write dispatch marker becomes a failed interrupted operation with no write effect.
An abandoned receipt with a write marker becomes uncertain.
The service never automatically executes the original command again after restart.
An optional provider reconciliation hook may inspect remote status using the original operation key and current authority, then conditionally refine the receipt.
If no such hook exists, expose uncertainty and the capability's documented manual check; do not invent exactly-once behavior.

## Command windows and result retention

Discovery issues an authenticated command-window token scoped to the current app, holder-or-binding owner and recovery generation.
The owner discriminator is retained: a binding-owned window remains tied to that exact binding even if subsequent access also carries a holder key.
Its public metadata advertises `admitsUntil`, `deduplicatesUntil` and `outputRetentionMs` before the client can submit a command.
The SDK retains the exact token and metadata with its request key and command before sending.
The server uses a maintained signing/verification library and current server time; client timestamps cannot extend the window.
The window is not authority to invoke, inspect or choose a connection.

Only a previously unrecorded command received during the admission interval can create a receipt.
The admission transaction rechecks the interval before admitting, with bounded transaction time and a configured safety margin.
No provider request occurs until that receipt commits.
After admission closes, resubmission can only return an already recorded, still-visible receipt within its history interval; it cannot create new work.
After `deduplicatesUntil`, submission returns `history-expired` even if the request key is absent.
Any window from a previous recovery generation returns expired-history handling under a new valid access context and cannot create work.
The SDK never obtains a fresh window for automatic replay of an old write.

Bounded outputs are encrypted and retained from terminal persistence for the advertised output interval, capped at the window's history deadline.
Late reconciliation may therefore have a shorter output interval, which the actual receipt reports; it does not silently extend an expired command window.
Each admitted response or inspection returns the shared receipt, including `deduplicatesUntil` and, once available, `resultAvailableUntil`.
Window issuance requires `deduplicatesUntil` to cover the end of admission plus the maximum execution deadline and advertised output retention.
Operational configuration changes cannot shorten guarantees already issued in valid windows.
Compact command tombstones remain through that deadline even after output deletion.
Output expiry returns `result-expired` with the safe receipt; it never starts another handler.

The lookup operation accepts the original token and request key without invoking a handler.
Within the supported history interval it returns the original pending/terminal receipt, or `not-recorded` when no committed visible receipt currently exists.
`not-recorded` is not proof that the original network request cannot still reach admission.
During the original admission interval, resubmitting the identical command with the same window and key is protected by the receipt's uniqueness constraint.
After admission closes, the SDK performs only lookup/inspection and does not infer permission for a new write from absence.
After history expiry, return `history-expired` and require application/operator reconciliation before any intentionally new write.
If the original window/key metadata was not retained, the SDK performs no automatic write resubmission.

Finite retention is intentional, including for unresolved outcomes.
The service does not promise result retrieval or duplicate suppression for a new command window after the old history is deliberately removed.
Its enforceable guarantee is that the original expired window cannot create a new write.
Neither a new request key nor a new window is a safe automatic recovery action for an uncertain old write.

## Private pagination seam

The public command's `input` is the capability's base query; `page: { size, cursor? }` is a separate transport/domain envelope.
Paginated capabilities require that page envelope and explicit size even for the first page; non-paginated capabilities reject it.
Validate the command envelope and base input first, then enforce the capability's read-only pagination declaration and page-size bound.
The stable query digest covers canonical validated base input only; it excludes the changing cursor, request key and command window.
Capability version, provider registration, resolved connection/epoch, app, holder-or-binding owner and page size are separately bound in the cursor.
The command digest still includes the public cursor and page size so reusing one request key for another page is a conflict.

For the first page, execution passes `page: { size }` in `CapabilityContext`.
For subsequent pages, it validates and decrypts the service cursor under current authority, recovery generation, query and connection state, then passes only `{ size, continuation }` to the handler.
The handler interprets the private continuation as its provider cursor, offset or page link and makes one bounded page's requests through the existing outbound seam.
Provider next-page links still pass endpoint validation.

The handler returns `HandlerResult<{ items: T[] }>` with an optional private `continuation`.
It must not return a public `nextCursor` or another cursor envelope in `value`.
Execution bounds and validates the continuation as JSON data, protects it using the service cursor mechanism with the current binding fields and expiry, and inserts only the resulting opaque token into `Page<T>.nextCursor`.
The completed public `Page<T>` is then validated against the published output schema before receipt persistence and HTTP serialization.
An invalid handler result is a safe provider-output error and never leaks private continuation.
Non-paginated capabilities reject a page input or continuation output.

The cursor is not authority and contains no provider secrets beyond encrypted continuation state.
It binds the active recovery generation and is rejected after restore even if its wall-clock expiry has not passed.
Changing permission, connection epoch, base query or page size invalidates it.
No stable snapshot across pages is promised unless the provider contract supports one; the capability describes live-page duplicates or omissions and any snapshot token.
Adding a second paginated provider changes only its continuation interpretation and handler, not cursor cryptography or caller authority logic.
