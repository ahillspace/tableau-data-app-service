import { ServiceError } from "../platform/errors.ts";
import type { Outbound } from "../platform/outbound.ts";
import {
  type ProviderType,
  readStandardTokenResponse,
  type TokenReading,
} from "./provider-types.ts";
import type { ConnectionDefinition } from "./types.ts";

/** RFC 6749 appendix B: client credentials in HTTP Basic are form-urlencoded first. */
function formEncode(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

/**
 * Calls a definition's token endpoint. The request is never retried; a transport failure is a
 * ServiceError whose `upstream` says whether the provider may have received it.
 */
export async function tokenRequest(
  outbound: Outbound,
  definition: ConnectionDefinition,
  clientSecret: string | undefined,
  parameters: Record<string, string>,
  signal: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  const endpoint = definition.tokenEndpoint;
  const clientId = definition.clientId;
  if (!endpoint || !clientId)
    throw new ServiceError(409, "oauth-not-configured", "The definition has no OAuth client");
  const body = new URLSearchParams(parameters);
  const headers: [string, string][] = [
    ["content-type", "application/x-www-form-urlencoded;charset=UTF-8"],
    ["accept", "application/json"],
  ];
  if (clientSecret && definition.tokenAuthentication !== "post")
    headers.push([
      "authorization",
      `Basic ${Buffer.from(`${formEncode(clientId)}:${formEncode(clientSecret)}`).toString("base64")}`,
    ]);
  else {
    body.set("client_id", clientId);
    if (clientSecret) body.set("client_secret", clientSecret);
  }
  const response = await outbound.request(new URL(endpoint), {
    method: "POST",
    headers,
    body: body.toString(),
    signal,
    privateHosts: definition.privateHosts,
  });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += (chunk as Buffer).length;
      if (size > 1024 * 1024) {
        response.body.destroy();
        throw new ServiceError(
          502,
          "token-response-invalid",
          "The token endpoint response is too large",
          { upstream: "may-have-been-sent" },
        );
      }
      chunks.push(chunk as Buffer);
    }
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(502, "upstream-interrupted", "The token endpoint response was cut off", {
      upstream: "may-have-been-sent",
      cause: error,
    });
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    try {
      // Some older providers answer with a form-encoded body.
      parsed = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
    } catch {
      parsed = null;
    }
  }
  return { status: response.status, body: parsed };
}

export function readTokens(
  type: ProviderType,
  definition: ConnectionDefinition,
  response: { status: number; body: unknown },
  refresh: boolean,
  now: Date,
): TokenReading {
  return type.readTokenResponse
    ? type.readTokenResponse(response, { definition, refresh, now })
    : readStandardTokenResponse(response, now);
}
