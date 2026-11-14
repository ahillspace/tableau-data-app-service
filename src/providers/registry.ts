import type { z } from "zod";
import type { ProviderContext } from "../core-ports.js";
import { ServiceError } from "../http/errors.js";
import type { CapabilityRef } from "../public/schemas.js";

export type CredentialBundle = {
  credentials: unknown;
  runtimeContext: Record<string, unknown>;
  display: { label?: string; accountLabel?: string };
  expiresAt: Date | null;
  accountKey: string | null;
  verifiedReauthorization: boolean;
};
export type Endpoint = {
  baseUrl: string;
  privateCidrs?: readonly string[];
  allowHttp?: boolean;
  resolveBase?: (context: Readonly<Record<string, unknown>>) => string;
  blockedPaths?: readonly string[];
};
export type HttpCapability = {
  ref: CapabilityRef;
  providerRegistrationId: string;
  http?: {
    input: { kind: "json"; schema: z.ZodType } | { kind: "http" };
    response: { kind: "json"; schema: z.ZodType } | { kind: "http" };
    handler(input: unknown, context: ProviderContext): Promise<unknown>;
  };
  // The Jobs owner supplies concrete runtime handlers separately, keyed by this ref.
  job?: {
    inputSchema: z.ZodType;
    resultSchema: z.ZodType;
    inputLimitBytes?: number;
    resultLimitBytes?: number;
    executionLimitSeconds?: number;
  };
};
export type ProviderRegistration = {
  id: string;
  revision: number;
  mode: "none" | "personal" | "operator";
  endpoints: Readonly<Record<string, Endpoint>>;
  credentialsSchema: z.ZodType;
  contextSchema: z.ZodType<Record<string, unknown>>;
  staticSetup?: {
    inputSchema: z.ZodType;
    prepare(
      input: unknown,
      context: {
        signal: AbortSignal;
        request: (
          url: string,
          init: { method: string; headers?: Headers; body?: string },
        ) => Promise<Response>;
      },
    ): Promise<CredentialBundle>;
    remote: boolean;
    mayInvalidate: boolean;
  };
  attach(snapshot: {
    credentials: unknown;
    runtimeContext: Readonly<Record<string, unknown>>;
  }): Headers;
  capabilities: readonly HttpCapability[];
};
export class ProviderRegistry {
  readonly #providers = new Map<string, ProviderRegistration>();
  readonly #capabilities = new Map<string, HttpCapability>();
  constructor(providers: readonly ProviderRegistration[]) {
    for (const provider of providers) {
      if (this.#providers.has(provider.id)) throw new Error("Duplicate provider registration");
      this.#providers.set(provider.id, provider);
      for (const capability of provider.capabilities) {
        const key = `${capability.ref.id}:${capability.ref.version}`;
        if (
          capability.providerRegistrationId !== provider.id ||
          (!capability.http && !capability.job) ||
          this.#capabilities.has(key)
        )
          throw new Error("Invalid capability registration");
        this.#capabilities.set(key, capability);
      }
    }
  }
  get(id: string): ProviderRegistration {
    const provider = this.#providers.get(id);
    if (!provider) throw new ServiceError(404, "not-found", "Provider not found");
    return provider;
  }
  capability(id: string, version: number): HttpCapability {
    const capability = this.#capabilities.get(`${id}:${version}`);
    if (!capability)
      throw new ServiceError(422, "unsupported-capability", "Capability version is unsupported");
    return capability;
  }
  all(): readonly ProviderRegistration[] {
    return [...this.#providers.values()];
  }
}
