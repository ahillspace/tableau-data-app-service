import type { FastifyRequest } from "fastify";
import type { IdentityService } from "../identity/sessions.ts";
import { signInRequired } from "../identity/sessions.ts";
import type { Principal } from "../identity/types.ts";

/** The service's own bearer header. The native `Authorization` header is never read. */
export const BEARER_HEADER = "tableau-service-authorization";

export function readBearer(request: FastifyRequest): string | undefined {
  const value = request.headers[BEARER_HEADER];
  if (typeof value !== "string") return undefined;
  const match = /^Bearer[ ]+([A-Za-z0-9_-]+)\s*$/i.exec(value);
  return match?.[1];
}

/** Any valid service session, app or operator. */
export async function caller(
  identity: IdentityService,
  request: FastifyRequest,
): Promise<Principal> {
  const principal = await identity.authenticate(readBearer(request));
  if (!principal) throw signInRequired();
  return principal;
}

/** An operator session whose identity is an operator now. App and restored sessions are refused. */
export function operator(identity: IdentityService, request: FastifyRequest): Promise<Principal> {
  return identity.authenticateOperator(readBearer(request));
}
