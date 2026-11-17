import type { FastifyRequest } from "fastify";
import type { IdentityService } from "../identity/sessions.ts";
import { signInRequired } from "../identity/sessions.ts";
import type { Principal } from "../identity/types.ts";
import { ServiceError } from "../platform/errors.ts";
import { hashToken, sameSecret } from "../platform/secrets.ts";
import { OPERATOR_COOKIE, readCookie } from "./cookies.ts";
export const BEARER_HEADER = "tableau-service-authorization";
export function readBearer(request: FastifyRequest): string | undefined {
  const value = request.headers[BEARER_HEADER];
  if (typeof value !== "string") return undefined;
  return /^Bearer[ ]+([A-Za-z0-9_-]+)\s*$/i.exec(value)?.[1];
}
export async function caller(
  identity: IdentityService,
  request: FastifyRequest,
): Promise<Principal> {
  const principal = await identity.authenticate(readBearer(request));
  if (!principal) throw signInRequired();
  return principal;
}
export const csrfTokenFor = (cookie: string): string => hashToken(`tdas-operator-csrf:${cookie}`);
/** Cookie transport is confined to admin routes; bearer CLI clients keep explicit transport. */
export async function operator(
  identity: IdentityService,
  request: FastifyRequest,
  options: { publicOrigin: string; consoleEnabled: boolean },
): Promise<Principal> {
  const cookie = options.consoleEnabled ? readCookie(request, OPERATOR_COOKIE) : undefined;
  if (cookie && request.headers[BEARER_HEADER] !== undefined)
    throw new ServiceError(
      400,
      "ambiguous-authentication",
      "Use one operator authentication transport",
    );
  if (!cookie) return identity.authenticateOperator(readBearer(request));
  if (!request.url.startsWith("/v1/admin/")) throw signInRequired();
  const origin = request.headers.origin,
    site = request.headers["sec-fetch-site"];
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  if (origin !== undefined && origin !== options.publicOrigin)
    throw new ServiceError(403, "origin-invalid", "The operator request must be same-origin");
  if (mutation) {
    const csrf = request.headers["x-tdas-csrf"];
    if (
      origin !== options.publicOrigin ||
      typeof csrf !== "string" ||
      !sameSecret(csrf, csrfTokenFor(cookie))
    )
      throw new ServiceError(
        403,
        "csrf-invalid",
        "The operator mutation did not pass CSRF verification",
      );
    if (
      (request.headers["content-length"] !== undefined &&
        request.headers["content-length"] !== "0") ||
      request.headers["transfer-encoding"] !== undefined
    ) {
      if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? ""))
        throw new ServiceError(415, "json-required", "Operator mutations use JSON");
    }
  } else if (origin !== options.publicOrigin && site !== "same-origin")
    throw new ServiceError(403, "origin-invalid", "The operator request needs same-origin context");
  return identity.authenticateOperator(cookie);
}
