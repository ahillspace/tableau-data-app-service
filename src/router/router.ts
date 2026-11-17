import type { Readable } from "node:stream";
import { selectApiHost } from "../connections/hosts.ts";
import type { ConnectionService } from "../connections/service.ts";
import type { ConnectionDefinition, OutgoingRequest } from "../connections/types.ts";
import { SERVICE_COOKIE_PREFIX } from "../http/cookies.ts";
import type { Principal } from "../identity/types.ts";
import type { Metrics } from "../operations/metrics.ts";
import { invalid, notFound, ServiceError } from "../platform/errors.ts";
import type { Log } from "../platform/log.ts";
import type { Outbound } from "../platform/outbound.ts";

/**
 * Headers that describe one connection, not the exchange. Removed in both directions.
 * `Expect` is included because the transport sends bodies without a 100-continue handshake.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "expect",
]);

export const HOST_HEADER = "tableau-service-host";

export type NativeRequest = {
  principal: Principal;
  definitionId: string;
  method: string;
  /** Everything after `/v1/native/{definitionId}`, path and query, exactly as the app sent it. */
  target: string;
  /** Raw header pairs as received. */
  headers: [string, string][];
  body: Readable | null;
  signal: AbortSignal;
};

export type NativeResponse = { status: number; headers: [string, string][]; body: Readable };

function hopByHop(headers: [string, string][]): Set<string> {
  const named = new Set(HOP_BY_HOP);
  for (const [name, value] of headers)
    if (name.toLowerCase() === "connection")
      for (const token of value.split(",")) named.add(token.trim().toLowerCase());
  return named;
}

/** A Cookie header without the service's own cookies, or undefined when nothing else is left. */
function withoutServiceCookies(value: string): string | undefined {
  const kept = value
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair && !pair.startsWith(SERVICE_COOKIE_PREFIX));
  return kept.length ? kept.join("; ") : undefined;
}

/**
 * Request headers as the provider receives them: the app's, minus the service's own headers and
 * cookies and hop-by-hop headers. Every other cookie the app sends passes through.
 */
export function forwardableRequestHeaders(headers: [string, string][]): [string, string][] {
  const drop = hopByHop(headers);
  const forwarded: [string, string][] = [];
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (drop.has(lower) || lower.startsWith("proxy-") || lower.startsWith("tableau-service-"))
      continue;
    if (lower === "cookie") {
      const kept = withoutServiceCookies(value);
      if (kept !== undefined) forwarded.push([name, kept]);
      continue;
    }
    forwarded.push([name, value]);
  }
  return forwarded;
}

/**
 * Response headers as the app receives them: the provider's, minus hop-by-hop, the provider's CORS
 * answer and any header in the service's own `Tableau-Service-` namespace, so only the service can
 * mark a response as its own.
 */
export function forwardableResponseHeaders(headers: [string, string][]): [string, string][] {
  const drop = hopByHop(headers);
  return headers.filter(([name]) => {
    const lower = name.toLowerCase();
    return (
      !drop.has(lower) &&
      !lower.startsWith("proxy-") &&
      !lower.startsWith("access-control-") &&
      !lower.startsWith("tableau-service-")
    );
  });
}

/**
 * Picks the API host and builds the raw request target. The app's path is kept byte for byte;
 * the only rule is that the URL it names stays on the chosen host and under its base path.
 */
export function destination(
  definition: ConnectionDefinition,
  target: string,
  requestedHost: string | undefined,
): { origin: string; target: string; url: URL } {
  const host = selectApiHost(definition.apiHosts, requestedHost);
  const base = new URL(host);
  const basePath = base.pathname.replace(/\/$/, "");
  if (target !== "" && !target.startsWith("/") && !target.startsWith("?"))
    throw invalid(
      [{ path: "path", rule: "under-api-host" }],
      "The path must stay under the API host",
    );
  const raw = `${basePath}${target}` || "/";
  let url: URL;
  try {
    url = new URL(raw.startsWith("/") ? raw : `/${raw}`, base.origin);
  } catch {
    throw invalid(
      [{ path: "path", rule: "under-api-host" }],
      "The path must stay under the API host",
    );
  }
  const under =
    url.pathname === basePath ||
    url.pathname === `${basePath}/` ||
    url.pathname.startsWith(`${basePath}/`) ||
    basePath === "";
  if (url.origin !== base.origin || !under)
    throw invalid(
      [{ path: "path", rule: "under-api-host" }],
      "The path must stay under the API host",
    );
  return { origin: base.origin, target: raw.startsWith("/") ? raw : `/${raw}`, url };
}

/** Forwards a Data App's native request with the definition's credential and streams the answer back. */
export class NativeRouter {
  readonly #connections: ConnectionService;
  readonly #outbound: Outbound;
  readonly #log: Log;
  readonly #metrics: Metrics | undefined;

  constructor(options: {
    connections: ConnectionService;
    outbound: Outbound;
    log: Log;
    metrics?: Metrics;
  }) {
    this.#connections = options.connections;
    this.#outbound = options.outbound;
    this.#log = options.log;
    this.#metrics = options.metrics;
  }

  /** Sends the request once. Never retries; a transport failure says whether the provider may have received it. */
  async forward(request: NativeRequest): Promise<NativeResponse> {
    let admitted = false;
    let upstreamMs: number | undefined;
    let recorded = false;
    const record = (status: number | "transport-error" | "cancelled" | "service-error") => {
      if (recorded || !admitted) return;
      recorded = true;
      try {
        this.#metrics?.recordNative({
          definitionId: request.definitionId,
          status,
          ...(upstreamMs !== undefined ? { upstreamMs } : {}),
        });
      } catch {}
    };
    try {
      const requested = request.headers.find(([n]) => n.toLowerCase() === HOST_HEADER)?.[1];
      const lease = await this.#connections.checkout(
        request.principal,
        request.definitionId,
        request.signal,
        requested,
      );
      admitted = true;
      const chosen = destination(lease.definition, request.target, requested);
      const outgoing: OutgoingRequest = {
        target: chosen.target,
        headers: forwardableRequestHeaders(request.headers),
      };
      lease.apply(outgoing);
      outgoing.headers.push(["host", chosen.url.host]);
      const started = performance.now();
      const response = await this.#outbound.request(chosen.url, {
        method: request.method,
        rawTarget: outgoing.target,
        headers: outgoing.headers,
        body: request.body,
        signal: request.signal,
        privateHosts: lease.definition.privateHosts,
      });
      upstreamMs = performance.now() - started;
      response.body.once("end", () => record(response.status));
      response.body.once("error", () =>
        record(request.signal.aborted ? "cancelled" : "transport-error"),
      );
      response.body.once("close", () =>
        record(
          response.body.readableEnded
            ? response.status
            : request.signal.aborted
              ? "cancelled"
              : "transport-error",
        ),
      );
      this.#log.info("native request", {
        definitionId: request.definitionId,
        method: request.method,
        host: chosen.url.host,
        status: response.status,
      });
      return {
        status: response.status,
        headers: forwardableResponseHeaders(response.headers),
        body: response.body,
      };
    } catch (error) {
      if (
        error instanceof ServiceError &&
        [
          "not-connected",
          "needs-authorization",
          "not-in-audience",
          "definition-disabled",
          "refresh-failed",
          "refresh-uncertain",
          "exchange-failed",
          "exchange-uncertain",
          "credential-incomplete",
        ].includes(error.code)
      )
        admitted = true;
      record(
        request.signal.aborted
          ? "cancelled"
          : error instanceof ServiceError && error.code.startsWith("upstream-")
            ? "transport-error"
            : error instanceof ServiceError
              ? error.status
              : "service-error",
      );
      throw error;
    }
  }

  /** Runs a preset capability with the same checkout and transport as native requests. */
  async capability(
    principal: Principal,
    definitionId: string,
    name: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const definition = await this.#connections.definitions.get(definitionId);
    const capability = this.#connections.definitions.extensions.capability(name);
    if (!definition || !capability) throw notFound("capability-not-found", "No such capability");
    const lease = await this.#connections.checkout(principal, definitionId, signal);
    return await capability.run({
      ...this.#connections.presetContext(lease.definition, signal),
      lease,
      principal,
      input,
    });
  }
}
