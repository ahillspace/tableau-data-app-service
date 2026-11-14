import {
  type AuthorizationBegin,
  authorizationBeginSchema,
  authorizationViewSchema,
  type ConnectionView,
  capabilityCollectionSchema,
  connectionCollectionSchema,
  connectionViewSchema,
  opaqueId,
  providerCollectionSchema,
  type StaticConnectionInput,
  staticConnectionInputSchema,
} from "../public/schemas.js";
import { ClientHttp, jsonRequest, ProtocolError } from "./http.js";
import { JobsClient } from "./jobs.js";
import { type CapabilityInvocation, NativeClient, type ProxyRequest } from "./native.js";

export class ServiceClient {
  readonly http: ClientHttp;
  readonly jobs: JobsClient;
  readonly #native: NativeClient;
  constructor(
    readonly options: {
      serviceOrigin: string;
      appId: string;
      deploymentId: string;
      fetch?: typeof fetch;
    },
  ) {
    opaqueId.parse(options.appId);
    opaqueId.parse(options.deploymentId);
    this.http = new ClientHttp(options.serviceOrigin, options.appId, options.fetch);
    this.jobs = new JobsClient(this.http);
    this.#native = new NativeClient(this.http);
  }
  close(): void {
    this.http.close();
  }
  async discover(options: { signal?: AbortSignal } = {}) {
    const providers = await this.http.json(
      `${this.http.appPath}/providers`,
      providerCollectionSchema.parse,
      options,
    );
    const capabilities = await this.http.json(
      `${this.http.appPath}/capabilities`,
      capabilityCollectionSchema.parse,
      options,
    );
    this.#native.setCapabilities(capabilities.items);
    return { providers: providers.items, capabilities: capabilities.items };
  }
  async connections(options: { provider?: string; signal?: AbortSignal } = {}) {
    const query = options.provider
      ? `?provider=${encodeURIComponent(opaqueId.parse(options.provider))}`
      : "";
    return (
      await this.http.json(
        `${this.http.appPath}/connections${query}`,
        connectionCollectionSchema.parse,
        options.signal ? { signal: options.signal } : {},
      )
    ).items;
  }
  connection(id: string, options: { signal?: AbortSignal } = {}) {
    return this.http.json(
      `${this.http.appPath}/connections/${encodeURIComponent(opaqueId.parse(id))}`,
      connectionViewSchema.parse,
      options,
    );
  }
  setupStatic(input: StaticConnectionInput, options: { signal?: AbortSignal } = {}) {
    return this.http.json(
      `${this.http.appPath}/connections/static`,
      connectionViewSchema.parse,
      jsonRequest(staticConnectionInputSchema.parse(input), options.signal),
    );
  }
  async disconnect(
    connection: Pick<ConnectionView, "id" | "authorityGeneration">,
    options: { signal?: AbortSignal } = {},
  ): Promise<ConnectionView> {
    const response = await this.http.fetch(
      `${this.http.appPath}/connections/${encodeURIComponent(opaqueId.parse(connection.id))}/disconnect`,
      jsonRequest({ expectedAuthorityGeneration: connection.authorityGeneration }, options.signal),
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProtocolError(
        `Disconnect failed (HTTP ${response.status}); refresh connection state before a new attempt`,
      );
    }
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || !("connection" in value))
      throw new ProtocolError("Invalid disconnect response");
    return connectionViewSchema.parse(value.connection);
  }
  beginAuthorization(input: AuthorizationBegin, options: { signal?: AbortSignal } = {}) {
    return this.http.json(
      `${this.http.appPath}/authorizations`,
      authorizationViewSchema.parse,
      jsonRequest(authorizationBeginSchema.parse(input), options.signal),
    );
  }
  authorization(id: string, options: { signal?: AbortSignal } = {}) {
    return this.http.json(
      `${this.http.appPath}/authorizations/${encodeURIComponent(opaqueId.parse(id))}`,
      authorizationViewSchema.parse,
      options,
    );
  }
  cancelAuthorization(id: string, options: { signal?: AbortSignal } = {}) {
    return this.http.json(
      `${this.http.appPath}/authorizations/${encodeURIComponent(opaqueId.parse(id))}/cancel`,
      authorizationViewSchema.parse,
      jsonRequest({}, options.signal),
    );
  }
  request(request: ProxyRequest, options: { signal?: AbortSignal } = {}) {
    return this.#native.request(request, options);
  }
  invoke(invocation: CapabilityInvocation, options: { signal?: AbortSignal } = {}) {
    return this.#native.invoke(invocation, options);
  }
}
