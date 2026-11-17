import type { Authentication, TokenResponseConfig } from "../../src/contracts/operator.ts";
export const standardTokenResponse: TokenResponseConfig = {
  format: "json",
  rules: { successStatuses: [200], rejectedGrant: [{ path: ["error"], equals: "invalid_grant" }] },
  mapping: {
    accessToken: ["access_token"],
    refreshToken: ["refresh_token"],
    expiresIn: ["expires_in"],
    scope: ["scope"],
  },
};
export function oauthAuthentication(provider: {
  origin: string;
  clientId: string;
}): Extract<Authentication, { method: "authorization_code" }> {
  return {
    method: "authorization_code",
    authorizationEndpoint: `${provider.origin}/authorize`,
    tokenEndpoint: `${provider.origin}/token`,
    clientAuthentication: { method: "client_secret_basic", clientId: provider.clientId },
    pkce: "S256",
    scopeParameter: { name: "scope", separator: " " },
    response: structuredClone(standardTokenResponse),
  };
}
