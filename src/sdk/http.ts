import { serviceErrorSchema } from "../public/schemas.js";

export class ProtocolError extends Error {}
export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string,
  ) {
    super(message);
  }
}

/** One client's page-local authority. Never persisted, added to a URL, or shared between clients. */
export class ClientHttp {
  readonly origin: string;
  readonly appPath: string;
  #bearer: string | undefined;
  #closed = false;
  #requests = new Set<AbortController>();

  constructor(
    origin: string,
    appId: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const url = new URL(origin);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    ) {
      throw new TypeError("A service origin using HTTPS is required (loopback HTTP is allowed)");
    }
    this.origin = url.origin;
    this.appPath = `/v1/apps/${encodeURIComponent(appId)}`;
  }

  setBearer(token: string): void {
    if (this.#closed || !token || /[\s\x00-\x1f\x7f]/.test(token))
      throw new TypeError("Invalid access token");
    this.#bearer = token;
  }
  clearBearer(): void {
    this.#bearer = undefined;
  }
  close(): void {
    this.#closed = true;
    this.#bearer = undefined;
    for (const request of this.#requests)
      request.abort(new DOMException("Client closed", "AbortError"));
    this.#requests.clear();
  }

  fetch(path: string, init: RequestInit = {}): Promise<Response> {
    return this.#request(path, init, "bearer");
  }
  identity(path: string, init: RequestInit): Promise<Response> {
    if (!path.startsWith("/v1/session/"))
      throw new TypeError("Credentialed transport is restricted to session handoff/restoration");
    return this.#request(path, init, "identity");
  }
  async #request(
    path: string,
    init: RequestInit,
    authority: "bearer" | "identity",
  ): Promise<Response> {
    if (this.#closed) throw new Error("Client is closed");
    if (!path.startsWith("/v1/") || path.startsWith("//") || path.includes("#"))
      throw new TypeError("Invalid service path");
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new TypeError("Invalid service origin");
    const headers = new Headers(init.headers);
    if (authority === "bearer") {
      if (!this.#bearer)
        throw new ServiceError(401, "authentication-required", "Sign in to continue", "");
      headers.set("Authorization", `Bearer ${this.#bearer}`);
    }
    const controller = new AbortController();
    this.#requests.add(controller);
    const signal = init.signal
      ? AbortSignal.any([controller.signal, init.signal])
      : controller.signal;
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        headers,
        signal,
        credentials: authority === "identity" ? "include" : "omit",
        redirect: "error",
        cache: "no-store",
      });
    } catch (error) {
      this.#requests.delete(controller);
      throw error;
    }
    if (!response.body) {
      this.#requests.delete(controller);
      return response;
    }
    // Keep cancellation ownership until the caller consumes/cancels the body, including late failure.
    const reader = response.body.getReader();
    const release = () => {
      this.#requests.delete(controller);
      reader.releaseLock();
    };
    const body = new ReadableStream<Uint8Array>(
      {
        pull: async (stream) => {
          try {
            const next = await reader.read();
            if (next.done) {
              release();
              stream.close();
            } else stream.enqueue(next.value);
          } catch (error) {
            release();
            stream.error(error);
          }
        },
        cancel: async (reason) => {
          try {
            await reader.cancel(reason);
          } finally {
            controller.abort(reason);
            release();
          }
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  async json<T>(path: string, parse: (input: unknown) => T, init: RequestInit = {}): Promise<T> {
    const response = await this.fetch(path, init);
    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ProtocolError(`Unclassified HTTP ${response.status}`);
      }
      const error = serviceErrorSchema.safeParse(body);
      if (!error.success)
        throw new ProtocolError(`Invalid service error (HTTP ${response.status})`);
      throw new ServiceError(
        response.status,
        error.data.error.code,
        error.data.error.message,
        error.data.requestId,
      );
    }
    try {
      return parse(await response.json());
    } catch (error) {
      throw new ProtocolError(
        `Invalid service response: ${error instanceof Error ? error.message : "invalid JSON"}`,
      );
    }
  }
}

export function jsonRequest(value: unknown, signal?: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
    ...(signal ? { signal } : {}),
  };
}
