import type { IncomingMessage, OutgoingHttpHeaders } from "node:http";

/** Routes that read or set a cookie from a Data App frame. They echo the Origin and allow credentials. */
export function isCredentialedRoute(method: string, path: string): boolean {
  if (method !== "POST" && method !== "OPTIONS") return false;
  return path === "/v1/session/restore" || /^\/v1\/app-sign-ins\/[^/]+\/redeem$/.test(path);
}

/** Paths answered as API routes, with CORS. Everything else is a top-level service page with none. */
export function isApiPath(path: string): boolean {
  if (path === "/v1/oauth/callback") return false;
  return path.startsWith("/v1/") || path.startsWith("/health/");
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

/** CORS headers for an actual (non-preflight) API response. */
export function corsHeaders(
  request: IncomingMessage,
  credentialed: boolean,
): Record<string, string> {
  const origin = header(request, "origin");
  if (
    (request.url ?? "").startsWith("/v1/admin/") &&
    request.headers.cookie?.includes("__Host-tdas-operator=")
  )
    return { vary: "Origin" };
  if (credentialed) {
    if (origin === undefined) return { vary: "Origin" };
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      vary: "Origin",
    };
  }
  return { "access-control-allow-origin": "*" };
}

/** Whether an OPTIONS request is a CORS preflight rather than an OPTIONS request meant for a provider. */
export function isPreflight(request: IncomingMessage): boolean {
  return (
    request.method === "OPTIONS" && header(request, "access-control-request-method") !== undefined
  );
}

/** A preflight answer allowing the requested method and every requested header. */
export function preflightHeaders(
  request: IncomingMessage,
  credentialed: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...corsHeaders(request, credentialed),
    "access-control-allow-methods": header(request, "access-control-request-method") ?? "GET",
    "access-control-max-age": "600",
  };
  const requested = header(request, "access-control-request-headers");
  if (requested) headers["access-control-allow-headers"] = requested;
  if (header(request, "access-control-request-private-network") === "true")
    headers["access-control-allow-private-network"] = "true";
  headers.vary = "Origin, Access-Control-Request-Method, Access-Control-Request-Headers";
  return headers;
}

/** Names every response header so the app can read all of them. `Set-Cookie` is never readable by script. */
export function exposeHeader(names: Iterable<string>): string | undefined {
  const exposed = new Set<string>();
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower === "set-cookie" || lower.startsWith("access-control-")) continue;
    exposed.add(lower);
  }
  return exposed.size ? [...exposed].join(", ") : undefined;
}

export function headerNames(headers: OutgoingHttpHeaders): string[] {
  return Object.keys(headers);
}
