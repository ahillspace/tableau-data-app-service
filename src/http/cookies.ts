import type { FastifyReply, FastifyRequest } from "fastify";

/** Every service cookie name starts with this, so the router can keep them from providers. */
export const SERVICE_COOKIE_PREFIX = "__Host-tdas-";
/** The approved operator session: read only by the shared operator API. */
export const OPERATOR_COOKIE = `${SERVICE_COOKIE_PREFIX}operator`;
export const CONSOLE_TX_COOKIE = `${SERVICE_COOKIE_PREFIX}console-tx`;
/** The Tableau sign-in session: first-party, read only in top-level service windows. */
export const SIGN_IN_COOKIE = `${SERVICE_COOKIE_PREFIX}sign-in`;
/** Binds a Tableau sign-in transaction to the browser that started it. */
export const TABLEAU_TX_COOKIE = `${SERVICE_COOKIE_PREFIX}tableau-tx`;
/** Lets Data App frames restore the sign-in session; partitioned per top-level site. */
export const RESTORE_COOKIE = `${SERVICE_COOKIE_PREFIX}restore`;

export function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    return /^[A-Za-z0-9_-]+$/.test(value) ? value : undefined;
  }
  return undefined;
}

type CookieOptions = {
  sameSite: "Lax" | "None" | "Strict";
  partitioned?: boolean;
  expiresAt?: Date;
  maxAgeSeconds?: number;
};

/** Every service cookie is `__Host-` prefixed: Secure, host-only, Path=/, HttpOnly. */
export function setCookie(
  reply: FastifyReply,
  name: string,
  value: string,
  options: CookieOptions,
): void {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    `SameSite=${options.sameSite}`,
  ];
  if (options.partitioned) parts.push("Partitioned");
  const maxAge =
    options.maxAgeSeconds ??
    (options.expiresAt
      ? Math.max(0, Math.floor((options.expiresAt.getTime() - Date.now()) / 1000))
      : undefined);
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  appendSetCookie(reply, parts.join("; "));
}

export function clearCookie(
  reply: FastifyReply,
  name: string,
  options: Pick<CookieOptions, "sameSite" | "partitioned">,
): void {
  setCookie(reply, name, "", { ...options, maxAgeSeconds: 0 });
}

function appendSetCookie(reply: FastifyReply, value: string): void {
  const existing = reply.getHeader("set-cookie");
  const list =
    existing === undefined
      ? []
      : Array.isArray(existing)
        ? existing.map(String)
        : [String(existing)];
  reply.header("set-cookie", [...list, value]);
}
