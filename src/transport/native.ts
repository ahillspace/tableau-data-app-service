import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import ipaddr from "ipaddr.js";
import { Agent, buildConnector, request as sendRequest } from "undici";
import type { NativeRequest } from "../core-ports.js";
import { ServiceError } from "../http/errors.js";
import type { Endpoint } from "../providers/registry.js";
import {
  allowedNativeHeader,
  HEADER_PROFILE,
  isReserved,
  validateHeaderPairs,
} from "../public/headers.js";

const providerResponses = new WeakSet<Response>();
export function responseOrigin(response: Response): "provider" | "service" {
  return providerResponses.has(response) ? "provider" : "service";
}
export type TransportPolicy = {
  connectTimeoutMs: number;
  headersTimeoutMs: number;
  stallTimeoutMs: number;
  maxSockets: number;
  uploadLimitBytes?: number;
};
function allowedAddress(address: string, endpoint: Endpoint): boolean {
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress())
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  // Metadata, unspecified, multicast and control scopes are never operator opt-ins.
  if (
    [
      "unspecified",
      "broadcast",
      "multicast",
      "linkLocal",
      "ipv4Mapped",
      "rfc6145",
      "rfc6052",
      "6to4",
      "teredo",
    ].includes(parsed.range())
  )
    return false;
  if (parsed.range() === "unicast") return true;
  return (endpoint.privateCidrs ?? []).some((cidr) => {
    const [network, bits] = ipaddr.parseCIDR(cidr);
    return parsed.kind() === network.kind() && parsed.match(network, bits);
  });
}
export function destination(
  endpoint: Endpoint,
  path: string,
  query?: URLSearchParams,
  context: Readonly<Record<string, unknown>> = {},
): URL {
  const base = new URL(endpoint.resolveBase ? endpoint.resolveBase(context) : endpoint.baseUrl);
  if (
    base.username ||
    base.password ||
    base.hash ||
    base.search ||
    (base.protocol !== "https:" && !(base.protocol === "http:" && endpoint.allowHttp))
  )
    throw new ServiceError(502, "invalid-destination", "Provider destination is invalid");
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    /[\x00-\x20\x7f]/.test(path) ||
    /%(?:2f|5c|2e)/i.test(path)
  )
    throw new ServiceError(400, "invalid-path", "Invalid native path");
  const url = new URL(`${base.pathname.replace(/\/$/, "")}${path}`, base.origin);
  if (
    url.origin !== base.origin ||
    !url.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`) ||
    url.pathname.split("/").some((part) => part === "." || part === "..")
  )
    throw new ServiceError(400, "invalid-path", "Invalid native path");
  if (
    (endpoint.blockedPaths ?? []).some(
      (blocked) => url.pathname === blocked || url.pathname.startsWith(`${blocked}/`),
    )
  )
    throw new ServiceError(
      403,
      "entrusted-authenticator",
      "Endpoint is excluded by credential custody policy",
    );
  if (query) url.search = query.toString();
  return url;
}
export class TransportScope {
  readonly #abort = new AbortController();
  readonly signal: AbortSignal;
  readonly #dispatchers = new Set<Agent>();
  readonly #bodies = new Set<Readable>();
  readonly #operations = new Set<Promise<unknown>>();
  #disposed = false;
  constructor(
    readonly policy: TransportPolicy,
    signal: AbortSignal,
  ) {
    this.signal = AbortSignal.any([signal, this.#abort.signal]);
  }

  async request(
    endpoint: Endpoint,
    native: NativeRequest,
    entrusted: Headers,
    context: Readonly<Record<string, unknown>> = {},
  ): Promise<Response> {
    this.signal.throwIfAborted();
    if (this.#disposed) throw new Error("Transport scope is disposed");
    const url = destination(endpoint, native.path, native.query, context);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await lookup(hostname, { all: true });
    if (!addresses.length || addresses.some(({ address }) => !allowedAddress(address, endpoint)))
      throw new ServiceError(403, "destination-denied", "Provider recipient is denied");
    const address = addresses[0];
    if (!address) throw new ServiceError(502, "dns-failed", "Provider destination unavailable");
    const connector = buildConnector({
      timeout: this.policy.connectTimeoutMs,
      rejectUnauthorized: true,
      autoSelectFamily: false,
      family: address.family,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
    });
    const dispatcher = new Agent({
      connections: this.policy.maxSockets,
      pipelining: 1,
      connect: (options, callback) => {
        connector(options, (error, socket) => {
          if (error || !socket) {
            callback(error ?? new Error("Connection failed"), null);
            return;
          }
          const remote = socket.remoteAddress;
          if (
            !remote ||
            !allowedAddress(remote, endpoint) ||
            ipaddr.process(remote).toString() !== ipaddr.process(address.address).toString()
          ) {
            socket.destroy();
            callback(new Error("Recipient changed at socket connection"), null);
            return;
          }
          callback(null, socket);
        });
      },
    });
    this.#dispatchers.add(dispatcher);
    const headers = new Headers();
    for (const [name, value] of native.headers ?? []) {
      if (!allowedNativeHeader(name) || entrusted.has(name))
        throw new ServiceError(400, "protected-header", "Caller header is protected");
      headers.append(name, value);
    }
    for (const [name, value] of entrusted) {
      if (isReserved(name)) throw new Error("Provider attempted to set a control header");
      headers.set(name, value);
    }
    let body: Readable | string | Buffer | undefined;
    if (native.body instanceof ReadableStream)
      body = Readable.fromWeb(native.body as import("node:stream/web").ReadableStream<Uint8Array>);
    else if (native.body !== undefined)
      body = typeof native.body === "string" ? native.body : Buffer.from(native.body);
    if (body !== undefined && this.policy.uploadLimitBytes !== undefined) {
      const limit = this.policy.uploadLimitBytes;
      if (typeof body === "string" || Buffer.isBuffer(body)) {
        if (Buffer.byteLength(body) > limit)
          throw new ServiceError(413, "upload-limit", "Configured upload limit exceeded");
      } else {
        let size = 0;
        const limiter = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            size += chunk.length;
            done(
              size > limit
                ? new ServiceError(413, "upload-limit", "Configured upload limit exceeded")
                : null,
              chunk,
            );
          },
        });
        const original = body;
        const piping = pipeline(original, limiter, { signal: this.signal }).catch(
          (error: unknown) => {
            limiter.destroy(error instanceof Error ? error : new Error("Upload failed"));
          },
        );
        this.#operations.add(piping);
        void piping.finally(() => this.#operations.delete(piping));
        body = limiter;
      }
    }
    try {
      const result = await sendRequest(url, {
        method: native.method,
        dispatcher,
        headers: Object.fromEntries(headers),
        ...(body !== undefined ? { body } : {}),
        signal: this.signal,
        idempotent: false,
        headersTimeout: this.policy.headersTimeoutMs,
        bodyTimeout: this.policy.stallTimeoutMs,
      });
      this.#bodies.add(result.body);
      result.body.once("close", () => {
        this.#bodies.delete(result.body);
        this.#dispatchers.delete(dispatcher);
        void dispatcher.destroy();
      });
      const pairs: [string, string][] = [];
      const connectionNames = new Set(
        String(result.headers.connection ?? "")
          .toLowerCase()
          .split(",")
          .map((name) => name.trim()),
      );
      for (const [name, value] of Object.entries(result.headers)) {
        if (
          value === undefined ||
          connectionNames.has(name) ||
          isReserved(name) ||
          name.startsWith("access-control-") ||
          [
            "set-cookie",
            "connection",
            "keep-alive",
            "proxy-authenticate",
            "transfer-encoding",
            "trailer",
            "upgrade",
          ].includes(name)
        )
          continue;
        for (const field of Array.isArray(value) ? value : [value]) pairs.push([name, field]);
      }
      try {
        validateHeaderPairs(pairs);
      } catch {
        result.body.destroy();
        throw new ServiceError(
          502,
          "invalid-provider-headers",
          "Provider headers exceed supported transport",
        );
      }
      const responseHeaders = new Headers(pairs);
      const bodyless = native.method === "HEAD" || [204, 205, 304].includes(result.statusCode);
      if (bodyless) result.body.destroy();
      const response = new Response(
        bodyless ? null : (Readable.toWeb(result.body) as ReadableStream<Uint8Array>),
        { status: result.statusCode, headers: responseHeaders },
      );
      providerResponses.add(response);
      return response;
    } catch (error) {
      this.#dispatchers.delete(dispatcher);
      await dispatcher.destroy();
      if (error instanceof ServiceError || this.signal.aborted) throw error;
      throw new ServiceError(
        502,
        "upstream-transport",
        "Provider transport failed; effects may be unknown",
      );
    }
  }
  async dispose(reason?: unknown): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#abort.abort(reason);
    for (const body of this.#bodies) body.destroy();
    await Promise.all([...this.#dispatchers].map((dispatcher) => dispatcher.destroy()));
    await Promise.allSettled(this.#operations);
    this.#bodies.clear();
    this.#dispatchers.clear();
  }
}
