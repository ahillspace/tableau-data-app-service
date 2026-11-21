import type { CredentialInput } from "../contracts/operator.js";

export type { CredentialInput };

/**
 * The browser SDK for Data Apps. It holds the service bearer in memory only, signs in through a
 * service popup, and returns native provider responses untouched. It validates only what it needs
 * to talk to the service and has no runtime dependencies.
 */

const BEARER_HEADER = "Tableau-Service-Authorization";
const ERROR_MARKER = "tableau-service-error";
const POPUP_FEATURES = "popup,width=520,height=720";
const RECONNECT_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export type Upstream = "not-sent" | "may-have-been-sent";
export type FieldError = { path: string; rule: string };

/** A failure reported by the service, or by the SDK before it reached the service. */
export class ServiceError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fields: FieldError[] | undefined;
  readonly upstream: Upstream | undefined;

  constructor(
    code: string,
    message: string,
    status = 0,
    extra: { fields?: FieldError[]; upstream?: Upstream } = {},
  ) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.status = status;
    this.fields = extra.fields;
    this.upstream = extra.upstream;
  }
}

export type Attribution = { siteContentUrl?: string; workbook?: string; view?: string };
export type Identity = { deploymentId: string; siteId: string; userId: string };

export type Session = {
  kind: "app" | "operator";
  identity: Identity;
  siteContentUrl: string;
  userName: string;
  appId: string | null;
  attribution: Attribution;
  location: { verified: boolean };
  expiresAt: string;
};

export type ConnectionStatus = "connected" | "not-connected" | "needs-authorization";

export type Definition = {
  id: string;
  displayName: string;
  method: string;
  ownership: "shared" | "personal";
  setup: { oauth: boolean; credential: boolean };
  status: ConnectionStatus;
  account: { id: string; name: string | null } | null;
  authorizedAt: string | null;
  scopes: string[];
};

export type JobState =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type Job = {
  id: string;
  handler: string;
  definitionId: string;
  owner: Identity;
  appId: string;
  submissionKey: string;
  state: JobState;
  attempt: number;
  progress?: unknown;
  externalTaskId?: string;
  cancelRequested: boolean;
  remoteEffectsUnknown: boolean;
  result?: { available: boolean; expiresAt: string };
  error?: { code: string; message: string; fields?: FieldError[]; upstream?: Upstream };
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};

export type ServiceEvent = {
  id: string;
  definitionId: string;
  type: string;
  account: string;
  payload: unknown;
  receivedAt: string;
};

export type LossReason =
  | "stream-start"
  | "slow-client"
  | "fan-out-reconnected"
  | "fan-out-unavailable"
  | (string & {});

export type SubscribeOptions = {
  /** Called when events may have been missed; nothing before it is replayed. */
  onLoss?(reason: LossReason): void;
  /** Called when the stream stops for good: closed by the service, or refused. */
  onEnd?(reason: string, error?: ServiceError): void;
};

export type Subscription = { close(): void };

export type ServiceOptions = {
  /** The service's origin, such as https://service.example. */
  origin: string;
  /** The Data App's own ID, recorded with each session. */
  appId: string;
  /** Overrides the attribution read from the page URL and referrer. */
  attribution?: Attribution;
  /** Replaces the global `fetch` and `window`, for tests and unusual hosts. */
  fetch?: typeof fetch;
  window?: Window;
};

const FINISHED: readonly JobState[] = ["succeeded", "failed", "cancelled", "interrupted"];

/** Reads site, workbook and view from a Tableau URL, such as `/#/site/sales/views/Book/Sheet`. */
export function readAttribution(...urls: string[]): Attribution {
  for (const value of urls) {
    if (!value) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    const route = `${url.pathname}${url.hash.replace(/^#/, "")}`;
    const views = /\/views\/([^/?#]+)(?:\/([^/?#]+))?/.exec(route);
    const site = /\/(?:site|t)\/([^/?#]+)/.exec(route);
    if (!views && !site) continue;
    const decode = (part: string | undefined) => (part ? decodeURIComponent(part) : undefined);
    const attribution: Attribution = {};
    const siteContentUrl = decode(site?.[1]);
    const workbook = decode(views?.[1]);
    const view = decode(views?.[2]);
    if (siteContentUrl) attribution.siteContentUrl = siteContentUrl;
    if (workbook) attribution.workbook = workbook;
    if (view) attribution.view = view;
    return attribution;
  }
  return {};
}

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function errorFrom(response: Response): Promise<ServiceError> {
  let body:
    | { error?: { code?: string; message?: string; fields?: FieldError[]; upstream?: Upstream } }
    | undefined;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const error = body?.error;
  return new ServiceError(
    error?.code ?? "service-error",
    error?.message ?? `The service answered ${response.status}`,
    response.status,
    {
      ...(error?.fields ? { fields: error.fields } : {}),
      ...(error?.upstream ? { upstream: error.upstream } : {}),
    },
  );
}

/** True when a request body can be sent a second time after a refreshed session. */
function replayable(body: BodyInit | null | undefined): boolean {
  return (
    body === undefined ||
    body === null ||
    !(typeof ReadableStream !== "undefined" && body instanceof ReadableStream)
  );
}

export class Service {
  readonly origin: string;
  readonly appId: string;
  readonly jobs: Jobs;
  readonly events: Events;
  readonly #fetch: typeof fetch;
  readonly #window: Window | undefined;
  readonly #attribution: Attribution | undefined;
  #bearer: string | undefined;
  #session: Session | undefined;
  #restoring: Promise<boolean> | undefined;

  constructor(options: ServiceOptions) {
    const origin = new URL(options.origin).origin;
    if (!options.appId) throw new ServiceError("invalid-options", "appId is required");
    this.origin = origin;
    this.appId = options.appId;
    this.#attribution = options.attribution;
    this.#window = options.window ?? (typeof window === "undefined" ? undefined : window);
    this.#fetch = options.fetch ?? fetch.bind(globalThis);
    this.jobs = new Jobs(this);
    this.events = new Events(this);
  }

  /** The current session, once signed in or restored. */
  get session(): Session | undefined {
    return this.#session;
  }

  get signedIn(): boolean {
    return this.#bearer !== undefined;
  }

  attribution(): Attribution {
    if (this.#attribution) return this.#attribution;
    const w = this.#window;
    return w ? readAttribution(w.location.href, w.document.referrer) : {};
  }

  #declaration(): { appId: string; attribution: Attribution } {
    return { appId: this.appId, attribution: this.attribution() };
  }

  #accept(body: { bearer: string; session: Session }): Session {
    this.#bearer = body.bearer;
    this.#session = body.session;
    return body.session;
  }

  /** Forgets the bearer in memory. The restore cookie is kept, so a later restore still works. */
  signOut(): void {
    this.#bearer = undefined;
    this.#session = undefined;
  }

  /**
   * Restores a session with no prompt, from the service's restore cookie. Returns false when the
   * user needs to sign in. Concurrent callers share one attempt.
   */
  restore(): Promise<boolean> {
    this.#restoring ??= (async () => {
      try {
        const response = await this.#fetch(`${this.origin}/v1/session/restore`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(this.#declaration()),
        });
        if (response.status === 401 || response.status === 403) {
          this.signOut();
          return false;
        }
        if (!response.ok) throw await errorFrom(response);
        this.#accept(await response.json());
        return true;
      } finally {
        this.#restoring = undefined;
      }
    })();
    return this.#restoring;
  }

  /**
   * First sign-in through a service popup. Call it from a user gesture: the popup opens
   * synchronously, before any network call, so the browser allows it.
   */
  signIn(): Promise<Session> {
    const popup = this.#openPopup();
    return (async () => {
      try {
        const proof = base64url(crypto.getRandomValues(new Uint8Array(32)));
        const proofHash = base64url(
          new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(proof))),
        );
        const started = await this.#json<{ transactionId: string; url: string }>(
          "POST",
          "/v1/app-sign-ins",
          {
            body: { proofHash, ...this.#declaration() },
            anonymous: true,
          },
        );
        popup.location.href = started.url;
        const message = await this.#awaitPopup(
          popup,
          "tableau-service:sign-in",
          started.transactionId,
        );
        const response = await this.#fetch(
          `${this.origin}/v1/app-sign-ins/${encodeURIComponent(started.transactionId)}/redeem`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code: message.code, proof }),
          },
        );
        if (!response.ok) throw await errorFrom(response);
        return this.#accept(await response.json());
      } finally {
        if (!popup.closed) popup.close();
      }
    })();
  }

  #openPopup(): Window {
    const popup = this.#window?.open("about:blank", "_blank", POPUP_FEATURES);
    if (!popup)
      throw new ServiceError(
        "popup-blocked",
        "The browser blocked the sign-in window; call this from a click",
      );
    return popup;
  }

  /** Waits for the service page in `popup` to post `type` for `transactionId`. */
  #awaitPopup(
    popup: Window,
    type: string,
    transactionId: string,
  ): Promise<Record<string, unknown>> {
    const w = this.#window as Window;
    return new Promise((resolve, reject) => {
      const done = () => {
        w.removeEventListener("message", onMessage);
        clearInterval(watch);
      };
      const onMessage = (event: MessageEvent) => {
        if (event.origin !== this.origin || event.source !== popup) return;
        const data = event.data as Record<string, unknown> | null;
        // A service page that failed before it knew the transaction reports a generic error.
        const failed = data?.type === "tableau-service:error";
        if (!data || (data.type !== type && !failed)) return;
        if (!failed && data.transactionId !== transactionId && data.transactionId !== "") return;
        done();
        if (failed || data.status === "failed")
          reject(
            new ServiceError(
              String(data.code ?? "failed"),
              "The service window reported a failure",
            ),
          );
        else resolve(data);
      };
      const watch = setInterval(() => {
        if (!popup.closed) return;
        done();
        reject(new ServiceError("popup-closed", "The window was closed before it finished"));
      }, 500);
      w.addEventListener("message", onMessage);
    });
  }

  /**
   * A service call with the bearer. When the service rejects the bearer itself with
   * `sign-in-required`, nothing was sent to a provider, so the SDK tries one restore and resends,
   * when the body can be sent again; a failed restore throws `sign-in-required`. Any other 401,
   * including a provider's, is never resent.
   */
  async request(
    path: string,
    init: RequestInit = {},
    options: { native?: boolean } = {},
  ): Promise<Response> {
    if (!this.#bearer && !(await this.restore())) throw this.#signInRequired();
    const send = () => {
      const headers = new Headers(init.headers);
      headers.set(BEARER_HEADER, `Bearer ${this.#bearer}`);
      // The bearer is a header fetch keeps across redirects, so a redirect is returned, never followed.
      return this.#fetch(`${this.origin}${path}`, {
        ...init,
        headers,
        credentials: "omit",
        redirect: "manual",
      });
    };
    let response = await send();
    const isServiceError = (r: Response) => !options.native || r.headers.get(ERROR_MARKER) === "1";
    if (
      response.status === 401 &&
      isServiceError(response) &&
      replayable(init.body) &&
      (await errorFrom(response.clone())).code === "sign-in-required"
    ) {
      if (!(await this.restore())) throw this.#signInRequired();
      response = await send();
    }
    if (isServiceError(response) && !response.ok) throw await errorFrom(response);
    return response;
  }

  #signInRequired(): ServiceError {
    return new ServiceError("sign-in-required", "Sign in with Tableau to continue", 401);
  }

  async #json<T>(
    method: string,
    path: string,
    options: { body?: unknown; anonymous?: boolean } = {},
  ): Promise<T> {
    const init: RequestInit = { method };
    if (options.body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(options.body);
    }
    if (options.anonymous) {
      const response = await this.#fetch(`${this.origin}${path}`, { ...init, credentials: "omit" });
      if (!response.ok) throw await errorFrom(response);
      return (await response.json()) as T;
    }
    return (await (await this.request(path, init)).json()) as T;
  }

  /** @internal Used by Jobs and Events. */
  call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.#json<T>(method, path, body === undefined ? {} : { body });
  }

  /**
   * A native request to the provider behind a definition. The provider's response is returned as
   * is, including its errors; only the service's own errors are thrown.
   */
  fetch(definitionId: string, path: string, init: RequestInit = {}): Promise<Response> {
    if (!path.startsWith("/"))
      throw new ServiceError("invalid-path", "The native path starts with /");
    return this.request(`/v1/native/${encodeURIComponent(definitionId)}${path}`, init, {
      native: true,
    });
  }

  /** Calls a named code capability. */
  async capability<T = unknown>(definitionId: string, name: string, input?: unknown): Promise<T> {
    const body = await this.call<{ result: T }>(
      "POST",
      `/v1/capabilities/${encodeURIComponent(definitionId)}/${encodeURIComponent(name)}`,
      { input },
    );
    return body.result;
  }

  /** Definitions this user's site may use, with ownership and this user's connection status. */
  async definitions(): Promise<Definition[]> {
    return (await this.call<{ definitions: Definition[] }>("GET", "/v1/definitions")).definitions;
  }

  async definition(id: string): Promise<Definition | undefined> {
    return (await this.definitions()).find((d) => d.id === id);
  }

  /**
   * Connects a personal OAuth definition in a service popup. Call it from a user gesture.
   * Resolves with the definition once connected.
   */
  connect(definitionId: string): Promise<Definition> {
    const popup = this.#openPopup();
    return (async () => {
      try {
        const started = await this.call<{ transactionId: string; url: string }>(
          "POST",
          `/v1/definitions/${encodeURIComponent(definitionId)}/connect`,
        );
        popup.location.href = started.url;
        try {
          await this.#awaitPopup(popup, "tableau-service:connect", started.transactionId);
        } catch (error) {
          // A window closed by hand may still have finished; the status decides.
          if (!(error instanceof ServiceError) || error.code !== "popup-closed") throw error;
        }
        const definition = await this.definition(definitionId);
        if (definition?.status !== "connected")
          throw new ServiceError("connect-incomplete", "The connection was not completed");
        return definition;
      } finally {
        if (!popup.closed) popup.close();
      }
    })();
  }

  /** Stores this user's static credential for a personal definition. */
  async setCredential(definitionId: string, credential: CredentialInput): Promise<Definition> {
    return (
      await this.call<{ definition: Definition }>(
        "PUT",
        `/v1/definitions/${encodeURIComponent(definitionId)}/credential`,
        {
          credential,
        },
      )
    ).definition;
  }

  /** Ends this user's personal connection. */
  async disconnect(definitionId: string): Promise<boolean> {
    return (
      await this.call<{ disconnected: boolean }>(
        "DELETE",
        `/v1/definitions/${encodeURIComponent(definitionId)}/connection`,
      )
    ).disconnected;
  }
}

export type SubmitOptions = {
  /** The definition whose credential the handler uses. */
  definition: string;
  /** The submission key: the same key and input return the same Job. A random key is used when omitted. */
  key?: string;
};

export class Jobs {
  readonly #service: Service;
  constructor(service: Service) {
    this.#service = service;
  }

  async submit(handler: string, input: unknown, options: SubmitOptions): Promise<Job> {
    const body = await this.#service.call<{ job: Job }>("POST", "/v1/jobs", {
      handler,
      definitionId: options.definition,
      input,
      submissionKey: options.key ?? crypto.randomUUID(),
    });
    return body.job;
  }

  async get(id: string): Promise<Job> {
    return (await this.#service.call<{ job: Job }>("GET", `/v1/jobs/${encodeURIComponent(id)}`))
      .job;
  }

  async list(filter: { state?: JobState; limit?: number } = {}): Promise<Job[]> {
    const query = new URLSearchParams();
    if (filter.state) query.set("state", filter.state);
    if (filter.limit) query.set("limit", String(filter.limit));
    const suffix = query.size ? `?${query}` : "";
    return (await this.#service.call<{ jobs: Job[] }>("GET", `/v1/jobs${suffix}`)).jobs;
  }

  async result<T = unknown>(id: string): Promise<T> {
    return (
      await this.#service.call<{ result: T }>("GET", `/v1/jobs/${encodeURIComponent(id)}/result`)
    ).result;
  }

  async cancel(id: string): Promise<Job> {
    return (
      await this.#service.call<{ job: Job }>("POST", `/v1/jobs/${encodeURIComponent(id)}/cancel`)
    ).job;
  }

  /** Polls until the Job finishes and returns it. */
  async wait(
    id: string,
    options: { intervalMs?: number; signal?: AbortSignal } = {},
  ): Promise<Job> {
    const interval = options.intervalMs ?? 2_000;
    for (;;) {
      options.signal?.throwIfAborted();
      const job = await this.get(id);
      if (FINISHED.includes(job.state)) return job;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, interval);
        options.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(options.signal?.reason);
          },
          { once: true },
        );
      });
    }
  }
}

export class Events {
  readonly #service: Service;
  constructor(service: Service) {
    this.#service = service;
  }

  /**
   * Opens a live event stream for definitions. The stream reconnects after a dropped connection
   * and reports `possible-loss`; it stops for good when closed, when the service ends it, or when
   * the service refuses it.
   */
  subscribe(
    definitionIds: string[],
    onEvent: (event: ServiceEvent) => void,
    options: SubscribeOptions = {},
  ): Subscription {
    const controller = new AbortController();
    let attempt = 0;
    const path = `/v1/events/stream?definitions=${encodeURIComponent(definitionIds.join(","))}`;
    const end = (reason: string, error?: ServiceError) => {
      if (controller.signal.aborted) return;
      controller.abort();
      options.onEnd?.(reason, error);
    };
    const run = async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await this.#service.request(path, { signal: controller.signal });
          attempt = 0;
          const finished = await this.#read(response, onEvent, options);
          if (finished !== undefined) return end(finished);
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof ServiceError && error.status >= 400 && error.status < 500)
            return end(error.code, error);
        }
        const delay = RECONNECT_MS[Math.min(attempt++, RECONNECT_MS.length - 1)] as number;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    };
    void run();
    return { close: () => controller.abort() };
  }

  /** Reads frames until the stream ends; returns the service's end reason, or undefined when it dropped. */
  async #read(
    response: Response,
    onEvent: (event: ServiceEvent) => void,
    options: SubscribeOptions,
  ): Promise<string | undefined> {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return undefined;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        let name = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const text = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") name = text;
          else if (field === "data") data.push(text);
        }
        if (!data.length) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data.join("\n"));
        } catch {
          continue;
        }
        if (name === "event") onEvent(parsed as ServiceEvent);
        else if (name === "possible-loss") options.onLoss?.(String(parsed.reason));
        else if (name === "end") {
          await reader.cancel().catch(() => {});
          return String(parsed.reason);
        }
      }
    }
  }
}

/** Creates the SDK for one Data App and one service. */
export function createService(options: ServiceOptions): Service {
  return new Service(options);
}
