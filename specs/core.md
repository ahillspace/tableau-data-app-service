# App policy, providers and capabilities

Status: proposal; shared terminology comes from [contracts.md](contracts.md).
The core owner controls app registration, capability publication and policy decisions.
The provider owner controls protocol behavior and capability handlers, while credential persistence remains with the connection module.

## App registration and policy

The operator registers an app with an immutable ID, enabled flag, monotonically increasing revision, exact allowed origins and an allowlist of versioned capability bindings.
Validate origins as HTTPS origins with no wildcard, path, credentials or query; permit localhost only through explicit development configuration.
An app URL can be recorded as administrative metadata, but its origin alone is not authority.
Reject unknown capability versions, identity mismatches, app connections owned by another app, duplicate bindings and incompatible provider associations atomically.
Configuration updates compare the previous revision and return CONFLICT rather than overwrite a concurrent operator edit.
Disabling an app blocks new discovery, authorization, execution, output delivery and event replay.
Re-enabling an app never silently reconnects disconnected credentials or replays failed writes.

App registrations have `enabled -> disabled -> enabled` transitions and no browser-controlled mutation path.
Removing a capability binding prevents new dispatch and future protected result delivery for that capability, while preserving internal execution history under retention policy.
App secrets are explicitly linked to each allowed app capability; knowing the secret's connection ID cannot select it for a different app or mode.
An app connection is owned by one app in this initial contract.
Reusing the same upstream service account across apps requires separate explicit connection records and risk review; cross-app secret sharing is not an implicit feature.

Discovery first validates trusted context, active app registration and current capability allowlist.
It returns public schemas, a stable capability reference, identity mode, effect, safe limits and whether a connection is required.
Discovery does not create connections, refresh credentials or make a provider request.
It cannot guarantee eventual provider availability or permission to every provider-side resource.
Authorization checks at dispatch remain authoritative.

```ts
type CapabilityDescriptor = {
  ref: CapabilityRef; description: string;
  inputSchema: object; outputSchema: object;
  identity: IdentityMode; effect: Effect;
  pagination: 'none' | 'cursor';
  limits: { maxDurationMs: number; maxInputBytes: number; maxOutputBytes: number };
  connection: 'not_required' | 'configured' | 'required';
};
type ExecutionGrant = {
  appId: Id; bindingId: Id; capability: CapabilityRef;
  appRevision: number; identity: IdentityMode;
  connection?: { id: Id; revision: number };
  authorization: object; authorityExpiresAt: string;
}; // internal value, not a bearer token or browser payload
```

For none identity, reject connectionId and require a capability whose authorization declaration is empty.
For app identity, reject connectionId and resolve only the current configured app connection.
For delegated identity, require an owned connection with matching app, binding, provider and authorization requirements; absence returns CONNECTION_REQUIRED.
The provider adapter evaluates actual granted authorization and credential usability against the capability requirement.
An expired or insufficient grant produces REAUTHORIZATION_REQUIRED when it can be repaired through authorization, otherwise FORBIDDEN or UNSUPPORTED according to the adapter's documented semantics.
Never expand permissions automatically or silently change identity after an authorization error.

## Provider module contract

Providers and capabilities are statically imported reviewed TypeScript modules.
There is no uploaded code, runtime package installation, arbitrary URL proxy or client-provided provider configuration.
Provider modules are trusted server code, so review and dependency control remain part of their security boundary.
The domain API keeps raw credentials out of capability handlers, but cannot sandbox malicious code in the same Node process.

```ts
type ProviderModule = {
  id: string;
  credentialStrategies: CredentialStrategy[];
  authorization: AuthorizationAdapter;
  transport: ProviderTransportDefinition;
  capabilities: CapabilityDefinition<unknown, unknown>[];
  events?: ProviderEventAdapter;
};
type CredentialStrategy = 'oauth_code' | 'api_key' | 'static_secret'
  | 'derived' | 'none';
type AuthorizationAdapter = {
  satisfies(granted: object, required: object): boolean;
  // begin, exchange, refresh, derive, revoke are optional strategy-specific hooks
  // with explicit unsupported declarations, defined by the connection specification
};
type ProviderTransportDefinition = {
  allowedEndpoints: readonly string[];
  operations: Record<string, {
    effect: Effect; credentialStrategy: CredentialStrategy;
    maxResponseBytes: number;
  }>;
};
```

The brokered client exposes only registered operation names and validated parameters, not unrestricted fetch(url) or a secret getter.
Provider transport owns endpoint construction, credential injection, redirect policy, timeout, response bounds and safe error classification.
Reject network redirects outside the reviewed endpoint allowlist and validate any provider-specific host configuration at operator configuration time.
DNS and outbound-network restrictions require implementation review for the deployed environment.
Capability metadata must declare all permitted transport operations; the registry verifies operation effect and credential compatibility.
One capability execution is one bounded logical operation with at most one externally effectful dispatch unless the provider offers a documented atomic/idempotent batch operation.
Multi-step writes, compensation and arbitrary workflows are out of scope, preventing a handler from hiding partially committed workflows behind a binary success flag.

The input/output schemas are JSON Schema-compatible runtime schemas compiled or checked through one maintained schema library selected during implementation.
TypeScript inference or generated SDK types must derive from these schemas rather than maintaining duplicate hand-written wire types.
Registration rejects schema constructs unsupported by the selected runtime or SDK generator.
Provider responses are untrusted input: validate shape, map to the public result, strip tokens/account metadata and validate the public output before persistence/delivery.
Do not return the upstream HTTP body as a generic capability result.

## Version and rollout rules

A capability reference's integer version is its public contract version.
Incompatible schema or effect/identity/authorization changes require a new version and explicit app opt-in.
The registry may contain old and new versions during migration; existing executions retain their exact version.
Additive output changes still need schema compatibility review because strict consumers may reject new properties.
Registration is validated at startup before serving requests; invalid modules fail readiness instead of partially publishing a catalog.
Runtime configuration changes are transactional and cannot introduce registry definitions missing from the deployed build.
Removing a deployed version is allowed only after active executions finish and the defined result/idempotency retention window expires, or after an explicit operator migration disables affected apps.

## Add a provider and capability

1. Create `providers/<provider-id>/index.ts` exporting ProviderModule and add its static import to the registry composition root.
2. Declare supported credential strategies and implement the required protocol hooks against official provider documentation.
3. Declare allowlisted transport operations, permission evaluation, provider error mapping and any idempotency/refresh guarantees.
4. Define a capability's schemas, immutable version, fixed identity, required authorization, effect, retry declaration, limits and handler.
5. Add contract fixtures for scope denial, expiry, malformed upstream output, timeout and effect ambiguity; add event fixtures only if that provider supports events.
6. Validate the complete registry, then let the operator enable the version for a configured app and explicitly select its app connection where applicable.

These paths are proposed implementation entrypoints, not files already present in this specification workspace.
The extension must not add a new local identity system or fork shared refresh, storage, error-envelope, pagination or idempotency logic.
If a provider needs a credential strategy the shared lifecycle cannot represent, propose that shared contract change explicitly and return UNSUPPORTED until implemented and reviewed.

## Synthetic design checks

Provider `sample-alpha` supplies `sample-alpha.lookup@1`, a cursor-paginated delegated read, and `sample-alpha.set-value@1`, a delegated write with no retry guarantee.
Provider `sample-beta` supplies `sample-beta.public-info@1`, a no-credential read, and `sample-beta.evaluate@1`, an app-credential read.
These are abstract contract fixtures; they do not imply a provider implementation or domain-specific feature requirement.
Adding sample-beta requires its module import and operator allowlist entries but no edits to sample-alpha handlers, connection ownership logic or execution envelopes.
Attempting to use sample-alpha's delegated connection for sample-beta fails provider matching before any outbound call.
