import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import { PassThrough, type Readable } from "node:stream";
import { getCACertificates } from "node:tls";
import ipaddr from "ipaddr.js";
import { Agent, buildConnector } from "undici";
import { ServiceError } from "./errors.ts";

/**
 * The largest header block Node's HTTP parsers accept, used for both inbound requests and provider
 * responses: the service sets no header size limit of its own, so only memory bounds the headers
 * an app or provider sends.
 */
export const UNLIMITED_HEADER_BYTES = 2 ** 32 - 1;

/**
 * Outgoing HTTPS shared by the router, connections and identity.
 * Every new socket's address is checked when it opens, TLS is always verified,
 * redirects are never followed and requests are never retried.
 */

export type Resolver = (hostname: string) => Promise<{ address: string; family: 4 | 6 }[]>;

export type OutboundOptions = {
  connectTimeoutMs: number;
  headersTimeoutMs: number;
  idleTimeoutMs: number;
  /** Additional trust anchors, for local stand-ins in tests. */
  extraCa?: string[];
  resolver?: Resolver;
};

export type OutboundRequest = {
  method: string;
  /**
   * The request target (path and query) sent exactly as given. Defaults to the URL's normalized
   * path and query. The router uses it to forward the app's path byte for byte.
   */
  rawTarget?: string;
  headers: [string, string][];
  body?: Readable | Buffer | string | null;
  signal?: AbortSignal;
  privateHosts: boolean;
};

export type OutboundResponse = {
  status: number;
  /** Raw header pairs as received, in order. */
  headers: [string, string][];
  body: Readable;
};

const METADATA = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "169.254.170.23",
  "100.100.100.200",
  "fd00:ec2::254",
  "fd00:ec2::23",
]);

export type AddressVerdict = "allowed" | "private" | "metadata";

export function classifyAddress(address: string): AddressVerdict {
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress())
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  if (METADATA.has(parsed.toNormalizedString()) || METADATA.has(parsed.toString()))
    return "metadata";
  return parsed.range() === "unicast" ? "allowed" : "private";
}

function addressAllowed(address: string, privateHosts: boolean): boolean {
  const verdict = classifyAddress(address);
  return verdict === "allowed" || (verdict === "private" && privateHosts);
}

const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })));
    });
  });

class RefusedDestination extends Error {
  readonly code = "TDAS_DESTINATION_REFUSED";
  readonly host: string;
  constructor(host: string) {
    super("destination refused");
    this.host = host;
  }
}

const NOT_SENT = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_NONAME",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
  "ETIMEDOUT",
]);

function codeOf(error: unknown): string {
  let current: unknown = error;
  for (let i = 0; i < 4 && current; i++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code !== "UND_ERR_SOCKET" && code !== "UND_ERR_ABORTED")
      return code;
    current = (current as { cause?: unknown }).cause;
  }
  return typeof (error as { code?: unknown })?.code === "string"
    ? (error as { code: string }).code
    : "";
}

function isTlsCode(code: string): boolean {
  return /CERT|SSL|TLS|SIGNATURE|ERR_SSL|HOSTNAME|ALTNAME/.test(code);
}

/** Maps a transport failure to the router's stable codes. */
export function classifyFailure(error: unknown, host: string): ServiceError {
  if (error instanceof ServiceError) return error;
  let current: unknown = error;
  for (let i = 0; i < 4 && current; i++) {
    if (current instanceof RefusedDestination)
      return new ServiceError(
        502,
        "destination-refused",
        `The destination ${host} is not allowed`,
        { upstream: "not-sent" },
      );
    current = (current as { cause?: unknown }).cause;
  }
  const code = codeOf(error);
  if (isTlsCode(code))
    return new ServiceError(502, "upstream-tls-failed", `TLS verification failed for ${host}`, {
      upstream: "not-sent",
    });
  if (
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    code === "TDAS_STALLED"
  )
    return new ServiceError(504, "upstream-timeout", `The request to ${host} timed out`, {
      upstream: "may-have-been-sent",
    });
  if (NOT_SENT.has(code))
    return new ServiceError(502, "upstream-unreachable", `Could not connect to ${host}`, {
      upstream: "not-sent",
    });
  return new ServiceError(502, "upstream-interrupted", `The connection to ${host} failed`, {
    upstream: "may-have-been-sent",
  });
}

export class Outbound {
  readonly #options: OutboundOptions;
  readonly #resolver: Resolver;
  readonly #agents = new Map<boolean, Agent>();
  readonly #ca: string[];

  constructor(options: OutboundOptions) {
    this.#options = options;
    this.#resolver = options.resolver ?? systemResolver;
    this.#ca = [
      ...new Set([
        ...getCACertificates("default"),
        ...getCACertificates("system"),
        ...(options.extraCa ?? []),
      ]),
    ];
  }

  #agent(privateHosts: boolean): Agent {
    let agent = this.#agents.get(privateHosts);
    if (agent) return agent;
    const resolver = this.#resolver;
    const connector = buildConnector({
      timeout: this.#options.connectTimeoutMs,
      rejectUnauthorized: true,
      ca: this.#ca,
      autoSelectFamily: false,
      lookup: (hostname, _opts, callback) => {
        resolver(hostname).then(
          (addresses) => {
            const first = addresses[0];
            if (!first || addresses.some((a) => !addressAllowed(a.address, privateHosts))) {
              callback(new RefusedDestination(hostname), "", 4);
              return;
            }
            if ((_opts as { all?: boolean }).all)
              (callback as unknown as (e: null, a: unknown[]) => void)(null, [
                { address: first.address, family: first.family },
              ]);
            else callback(null, first.address, first.family);
          },
          (error: unknown) => callback(error as NodeJS.ErrnoException, "", 4),
        );
      },
    });
    agent = new Agent({
      maxHeaderSize: UNLIMITED_HEADER_BYTES,
      connect: (options, callback) => {
        connector(options, (error, socket) => {
          if (error || !socket) {
            callback(error ?? new Error("connect failed"), null);
            return;
          }
          const remote = socket.remoteAddress;
          if (!remote || !addressAllowed(remote, privateHosts)) {
            socket.destroy();
            callback(new RefusedDestination(options.hostname), null);
            return;
          }
          callback(null, socket);
        });
      },
    });
    this.#agents.set(privateHosts, agent);
    return agent;
  }

  /** Sends one request. The caller owns the response body and must consume or destroy it. */
  async request(url: URL, init: OutboundRequest): Promise<OutboundResponse> {
    const host = url.host;
    if (url.protocol !== "https:")
      throw new ServiceError(502, "destination-refused", `The destination ${host} is not HTTPS`, {
        upstream: "not-sent",
      });
    const literal = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(literal) && !addressAllowed(literal, init.privateHosts))
      throw new ServiceError(502, "destination-refused", `The destination ${host} is not allowed`, {
        upstream: "not-sent",
      });

    let body: Readable | Buffer | string | undefined;
    let stall: NodeJS.Timeout | undefined;
    if (init.body && typeof init.body === "object" && "pipe" in init.body) {
      const source = init.body;
      const pass = new PassThrough({ highWaterMark: 64 * 1024 });
      let last = performance.now();
      const idle = this.#options.idleTimeoutMs;
      // Activity is read from the source; a listener on the pass-through would drain it.
      source.on("data", () => {
        last = performance.now();
      });
      source.once("error", (error) => pass.destroy(error));
      source.pipe(pass);
      stall = setInterval(
        () => {
          if (pass.writableEnded || pass.destroyed) return;
          if (performance.now() - last >= idle) {
            const error = Object.assign(new Error("upload stalled"), { code: "TDAS_STALLED" });
            pass.destroy(error);
            source.destroy(error);
          }
        },
        Math.max(10, Math.min(1000, Math.floor(idle / 4))),
      );
      stall.unref();
      pass.once("close", () => clearInterval(stall));
      body = pass;
    } else if (init.body !== null && init.body !== undefined) {
      body = init.body as Buffer | string;
    }

    try {
      const result = await this.#agent(init.privateHosts).request({
        origin: url.origin,
        path: init.rawTarget ?? `${url.pathname}${url.search}`,
        method: init.method,
        headers: init.headers.flat(),
        ...(body !== undefined ? { body } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
        idempotent: false,
        headersTimeout: this.#options.headersTimeoutMs,
        bodyTimeout: this.#options.idleTimeoutMs,
      });
      const pairs: [string, string][] = [];
      for (const [name, value] of Object.entries(result.headers)) {
        if (value === undefined) continue;
        for (const v of Array.isArray(value) ? value : [value]) pairs.push([name, v]);
      }
      return { status: result.statusCode, headers: pairs, body: result.body };
    } catch (error) {
      if (stall) clearInterval(stall);
      if (body && typeof body === "object" && "destroy" in body) (body as Readable).destroy();
      if (init.signal?.aborted) throw init.signal.reason ?? error;
      throw classifyFailure(error, host);
    }
  }

  /** A fetch for protocol calls (OAuth, OpenID Connect, Tableau REST). Bodies are small and buffered. */
  fetcher(privateHosts: boolean): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers: [string, string][] = [];
      new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach(
        (value, name) => {
          headers.push([name, value]);
        },
      );
      let body: string | Buffer | undefined;
      const source = init?.body;
      if (source !== undefined && source !== null) {
        if (typeof source === "string") body = source;
        else if (source instanceof URLSearchParams) body = source.toString();
        else if (source instanceof Uint8Array) body = Buffer.from(source);
        else if (source instanceof ArrayBuffer) body = Buffer.from(source);
        else throw new TypeError("Unsupported protocol request body");
      }
      const response = await this.request(url, {
        method: init?.method ?? "GET",
        headers,
        ...(body !== undefined ? { body } : {}),
        ...(init?.signal ? { signal: init.signal } : {}),
        privateHosts,
      });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += (chunk as Buffer).length;
        if (size > 4 * 1024 * 1024) {
          response.body.destroy();
          throw new ServiceError(
            502,
            "upstream-response-invalid",
            `The response from ${url.host} is too large to parse`,
          );
        }
        chunks.push(chunk as Buffer);
      }
      const out = new Headers();
      for (const [name, value] of response.headers) {
        try {
          out.append(name, value);
        } catch {}
      }
      return new Response(
        [101, 204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks),
        {
          status: response.status,
          headers: out,
        },
      );
    }) as typeof fetch;
  }

  async close(): Promise<void> {
    await Promise.all([...this.#agents.values()].map((agent) => agent.close()));
    this.#agents.clear();
  }
}
