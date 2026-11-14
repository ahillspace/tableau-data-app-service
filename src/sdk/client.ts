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
  type SessionResponse,
  type StaticConnectionInput,
  sessionBeginSchema,
  sessionResponseSchema,
  sessionTransactionSchema,
  staticConnectionInputSchema,
} from "../public/schemas.js";
import { correlatedPopup, initiationProof, openPopup } from "./handoff.js";
import { ClientHttp, jsonRequest, ProtocolError, ServiceError } from "./http.js";
import { JobsClient } from "./jobs.js";
import { type CapabilityInvocation, NativeClient, type ProxyRequest } from "./native.js";

export class ServiceClient {
  readonly http: ClientHttp;
  readonly jobs: JobsClient;
  readonly #native: NativeClient;
  readonly #lifetime = new AbortController();
  #session: SessionResponse | undefined;
  #identityChange = false;
  #identityRevision = 0;
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
    this.#lifetime.abort(new DOMException("Client closed", "AbortError"));
    this.#session = undefined;
    this.http.close();
  }
  session(): Omit<SessionResponse, "accessToken"> | undefined {
    if (!this.#session) return;
    const { accessToken: _token, ...safe } = this.#session;
    return { ...safe, identity: { ...safe.identity } };
  }
  async restore(
    options: { signal?: AbortSignal } = {},
  ): Promise<Omit<SessionResponse, "accessToken">> {
    if (this.#identityChange) throw new Error("An identity change is already in progress");
    const revision = this.#identityRevision;
    let session: SessionResponse;
    try {
      session = await this.http.identityJson(
        "/v1/session/restore",
        sessionResponseSchema.parse,
        jsonRequest(
          { appId: this.options.appId, deploymentId: this.options.deploymentId },
          options.signal,
        ),
      );
    } catch (error) {
      if (
        revision === this.#identityRevision &&
        error instanceof ServiceError &&
        error.status === 401
      ) {
        this.http.clearBearer(true);
        this.#session = undefined;
        this.#native.setCapabilities([]);
      }
      throw error;
    }
    if (revision !== this.#identityRevision)
      throw new DOMException("Identity changed during restoration", "AbortError");
    if (this.#session && !sameIdentity(this.#session, session)) {
      this.http.clearBearer(true);
      this.#session = undefined;
      this.#native.setCapabilities([]);
      throw new ServiceError(
        401,
        "identity-changed",
        "Service identity changed; sign in again",
        "",
      );
    }
    this.#adopt(session);
    return this.session()!;
  }
  initialize(options: { signal?: AbortSignal } = {}) {
    return this.restore(options);
  }
  #adopt(session: SessionResponse): void {
    if (session.identity.deploymentId !== this.options.deploymentId)
      throw new ProtocolError("Restored identity belongs to a different deployment");
    if (
      Date.parse(session.authenticationExpiresAt) <= Date.now() ||
      Date.parse(session.expiresAt) <= Date.now() ||
      Date.parse(session.expiresAt) > Date.parse(session.authenticationExpiresAt)
    )
      throw new ProtocolError("Invalid fixed authentication expiry");
    if (this.#session && !sameIdentity(this.#session, session)) this.http.clearBearer(true);
    this.http.setBearer(session.accessToken);
    this.#session = session;
  }
  async signIn(
    options: { signal?: AbortSignal } = {},
  ): Promise<Omit<SessionResponse, "accessToken">> {
    if (this.#identityChange) throw new Error("An identity change is already in progress");
    const popup = openPopup();
    this.#identityRevision++;
    this.#identityChange = true;
    this.#session = undefined;
    this.http.clearBearer(true);
    this.#native.setCapabilities([]);
    const signal = options.signal
      ? AbortSignal.any([this.#lifetime.signal, options.signal])
      : this.#lifetime.signal;
    try {
      const proof = await initiationProof();
      const transaction = await this.http.identityJson(
        "/v1/session/transactions",
        sessionTransactionSchema.parse,
        jsonRequest(
          sessionBeginSchema.parse({
            appId: this.options.appId,
            deploymentId: this.options.deploymentId,
            initiationVerifier: proof.verifier,
          }),
          signal,
        ),
      );
      await correlatedPopup({
        popup,
        serviceOrigin: this.http.origin,
        transactionId: transaction.id,
        launchUrl: transaction.launchUrl,
        proof: proof.proof,
        expiresAt: transaction.expiresAt,
        signal,
      });
      const session = await this.http.identityJson(
        `/v1/session/transactions/${encodeURIComponent(transaction.id)}/redeem`,
        sessionResponseSchema.parse,
        jsonRequest({ initiationProof: proof.proof }, signal),
      );
      this.#adopt(session);
      return this.session()!;
    } finally {
      popup.close();
      this.#identityChange = false;
    }
  }
  async connect(
    input: Omit<AuthorizationBegin, "initiationVerifier">,
    options: { signal?: AbortSignal } = {},
  ): Promise<ConnectionView> {
    const popup = openPopup();
    const signal = options.signal
      ? AbortSignal.any([this.#lifetime.signal, options.signal])
      : this.#lifetime.signal;
    try {
      const proof = await initiationProof();
      const transaction = await this.beginAuthorization(
        { ...input, initiationVerifier: proof.verifier },
        { signal },
      );
      await correlatedPopup({
        popup,
        serviceOrigin: this.http.origin,
        transactionId: transaction.id,
        launchUrl: `/v1/authorizations/${encodeURIComponent(transaction.id)}/launch`,
        proof: proof.proof,
        expiresAt: transaction.expiresAt,
        signal,
      });
      const completed = await this.authorization(transaction.id, { signal });
      if (completed.state !== "succeeded" || !completed.connectionId)
        throw new Error(completed.error?.message ?? "Provider authorization did not complete");
      return this.connection(completed.connectionId, { signal });
    } finally {
      popup.close();
    }
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

function sameIdentity(before: SessionResponse, after: SessionResponse): boolean {
  return (
    before.identity.deploymentId === after.identity.deploymentId &&
    before.identity.siteId === after.identity.siteId &&
    before.identity.subjectId === after.identity.subjectId
  );
}
