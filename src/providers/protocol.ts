import { IdentityProtocol } from "../access/adapters.js";
import type { TransportPolicy } from "../transport/native.js";
import type { ProviderRegistration } from "./registry.js";

// Protocol custody endpoints are trusted declaration data, never browser input.
// Native proxy blocks remain in force on its separate endpoint declarations.
export function providerProtocol(provider: ProviderRegistration, policy: TransportPolicy) {
  const endpoints = new Map(
    Object.values(provider.endpoints).map((endpoint) => {
      const { blockedPaths: _blockedPaths, resolveBase: _resolveBase, ...fixed } = endpoint;
      const origin = new URL(endpoint.baseUrl).origin;
      return [origin, { ...fixed, baseUrl: origin }] as const;
    }),
  );
  if (provider.oauth?.metadata.token_endpoint) {
    const origin = new URL(provider.oauth.metadata.token_endpoint).origin;
    if (!endpoints.has(origin)) endpoints.set(origin, { baseUrl: origin });
  }
  return new IdentityProtocol(policy, endpoints);
}
