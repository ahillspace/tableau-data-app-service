import { createHash, randomUUID } from "node:crypto";
import * as oauth from "oauth4webapi";
import { z } from "zod";
import type { VerifiedIdentity } from "../core-ports.js";
import { ServiceError } from "../http/errors.js";
import type { Endpoint } from "../providers/registry.js";
import { randomSecret } from "../security/secrets.js";
import { protocolJson } from "../transport/json.js";
import { type TransportPolicy, TransportScope } from "../transport/native.js";

export type AdapterState = {
  state: string;
  verifier: string;
  nonce: string;
  clientId: string;
  deviceId: string;
};
export interface IdentityAdapter {
  readonly id: string;
  readonly deploymentId: string;
  readonly callbackUri: string;
  begin(): Promise<{ authorizationUrl: string; protectedState: AdapterState }>;
  complete(
    state: AdapterState,
    callback: URLSearchParams,
    signal: AbortSignal,
  ): Promise<VerifiedIdentity>;
}
export const CLOUD_METADATA: oauth.AuthorizationServer = Object.freeze({
  issuer: "https://sso.online.tableau.com",
  authorization_endpoint: "https://sso.online.tableau.com/oauth2/authorize",
  token_endpoint: "https://sso.online.tableau.com/oauth2/token",
  userinfo_endpoint: "https://sso.online.tableau.com/userinfo",
  jwks_uri: "https://sso.online.tableau.com/oauth2/jwks",
  id_token_signing_alg_values_supported: ["ES256"],
});
const sessionSchema = z.object({
  session: z.object({
    site: z.object({ id: z.string().min(1).max(200) }),
    user: z.object({ id: z.string().min(1).max(200) }),
  }),
});
function reject(): never {
  throw new ServiceError(
    401,
    "identity-verification-failed",
    "Tableau identity could not be verified",
  );
}

export class IdentityProtocol {
  constructor(
    readonly policy: TransportPolicy,
    readonly endpoints: ReadonlyMap<string, Endpoint>,
  ) {}
  open(signal: AbortSignal) {
    const transport = new TransportScope(this.policy, signal);
    const fetcher = async (
      input: string | URL | Request,
      init?: {
        method?: string | undefined;
        headers?: HeadersInit | undefined;
        body?: BodyInit | null | undefined;
        signal?: AbortSignal | null | undefined;
      },
    ): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const endpoint = this.endpoints.get(url.origin);
      if (!endpoint) throw new Error("Identity endpoint is not approved");
      const headers = new Headers(init?.headers);
      headers.set("accept-encoding", "identity");
      let body: string | undefined;
      if (init?.body !== undefined && init.body !== null) {
        if (typeof init.body === "string" || init.body instanceof URLSearchParams)
          body = init.body.toString();
        else throw new Error("Unsupported identity protocol body");
      }
      const response = await transport.request(
        endpoint,
        {
          endpoint: "identity",
          method: z.enum(["GET", "POST"]).parse(init?.method ?? "GET"),
          path: url.pathname,
          query: url.searchParams,
          ...(body === undefined ? {} : { body }),
        },
        headers,
      );
      const data = await protocolJson(response);
      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    };
    return { fetch: fetcher, dispose: () => transport.dispose() };
  }
}
export class CloudIdentityAdapter implements IdentityAdapter {
  readonly id = "tableau-cloud";
  constructor(
    readonly deploymentId: string,
    readonly callbackUri: string,
    readonly clientId: string,
    readonly podOrigin: string,
    readonly protocol: IdentityProtocol,
    readonly metadata: oauth.AuthorizationServer = CLOUD_METADATA,
  ) {}
  async begin() {
    const protectedState: AdapterState = {
      state: randomSecret(),
      verifier: oauth.generateRandomCodeVerifier(),
      nonce: randomSecret(),
      clientId: this.clientId,
      deviceId: randomUUID(),
    };
    const url = new URL(this.metadata.authorization_endpoint ?? reject());
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: this.callbackUri,
      scope: "openid email",
      state: protectedState.state,
      nonce: protectedState.nonce,
      code_challenge: await oauth.calculatePKCECodeChallenge(protectedState.verifier),
      code_challenge_method: "S256",
    }).toString();
    return { authorizationUrl: url.href, protectedState };
  }
  async complete(
    state: AdapterState,
    callback: URLSearchParams,
    signal: AbortSignal,
  ): Promise<VerifiedIdentity> {
    const scope = this.protocol.open(signal);
    try {
      if (state.clientId !== this.clientId) reject();
      const client: oauth.Client = {
        client_id: this.clientId,
        id_token_signed_response_alg: "ES256",
      };
      const parameters = oauth.validateAuthResponse(this.metadata, client, callback, state.state);
      const response = await oauth.authorizationCodeGrantRequest(
        this.metadata,
        client,
        oauth.None(),
        parameters,
        this.callbackUri,
        state.verifier,
        { [oauth.customFetch]: scope.fetch, signal },
      );
      const tokens = await oauth.processAuthorizationCodeResponse(this.metadata, client, response, {
        expectedNonce: state.nonce,
        requireIdToken: true,
      });
      await oauth.validateApplicationLevelSignature(this.metadata, response, {
        [oauth.customFetch]: scope.fetch,
        signal,
      });
      const claims = oauth.getValidatedIdTokenClaims(tokens);
      if (!claims || (claims.azp !== undefined && claims.azp !== this.clientId)) reject();
      if (claims.at_hash !== undefined) {
        const hash = createHash("sha256")
          .update(tokens.access_token)
          .digest()
          .subarray(0, 16)
          .toString("base64url");
        if (claims.at_hash !== hash) reject();
      }
      const userInfoResponse = await oauth.userInfoRequest(
        this.metadata,
        client,
        tokens.access_token,
        { [oauth.customFetch]: scope.fetch, signal },
      );
      await oauth.processUserInfoResponse(this.metadata, client, claims.sub, userInfoResponse);
      const sessionResponse = await scope.fetch(`${this.podOrigin}/api/3.24/sessions/current`, {
        headers: { authorization: `Bearer ${tokens.access_token}`, accept: "application/json" },
        signal,
      });
      if (!sessionResponse.ok) reject();
      const session = sessionSchema.parse(await sessionResponse.json()).session;
      return {
        deploymentId: this.deploymentId,
        siteId: session.site.id,
        subjectId: session.user.id,
        verifiedAt: new Date(),
        adapterId: this.id,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      reject();
    } finally {
      await scope.dispose();
    }
  }
}

export class ServerIdentityAdapter implements IdentityAdapter {
  readonly id = "tableau-server-reference";
  constructor(
    readonly deploymentId: string,
    readonly callbackUri: string,
    readonly serverOrigin: string,
    readonly targetSite: string,
    readonly expectedSiteId: string,
    readonly apiVersion: string,
    readonly clientType: string,
    readonly protocol: IdentityProtocol,
  ) {
    if (
      new URL(callbackUri).pathname !== "/Callback" ||
      !/^3\.\d+$/.test(apiVersion) ||
      !clientType ||
      clientType === "tableau-mcp"
    )
      throw new Error(
        "Server requires its supported callback/version and an explicitly registered service client type",
      );
  }
  async begin() {
    const protectedState: AdapterState = {
      state: randomSecret(),
      verifier: oauth.generateRandomCodeVerifier(),
      nonce: randomSecret(),
      clientId: randomUUID(),
      deviceId: randomUUID(),
    };
    const url = new URL("/oauth2/v1/auth", this.serverOrigin);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: protectedState.clientId,
      state: protectedState.state,
      code_challenge: await oauth.calculatePKCECodeChallenge(protectedState.verifier),
      code_challenge_method: "S256",
      redirect_uri: this.callbackUri,
      target_site: this.targetSite,
      device_id: protectedState.deviceId,
      device_name: "Data App integration service",
      client_type: this.clientType,
      redirected: "true",
    }).toString();
    return { authorizationUrl: url.href, protectedState };
  }
  async complete(
    state: AdapterState,
    callback: URLSearchParams,
    signal: AbortSignal,
  ): Promise<VerifiedIdentity> {
    const scope = this.protocol.open(signal);
    try {
      if (
        callback.getAll("state").length !== 1 ||
        callback.get("state") !== state.state ||
        callback.getAll("code").length !== 1 ||
        callback.has("error")
      )
        reject();
      const response = await scope.fetch(`${this.serverOrigin}/oauth2/v1/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: callback.get("code") ?? "",
          code_verifier: state.verifier,
          redirect_uri: this.callbackUri,
          client_id: state.clientId,
        }),
        signal,
      });
      if (!response.ok) reject();
      const tokens = z
        .object({ access_token: z.string().min(1), origin_host: z.string() })
        .parse(await response.json());
      const origin = tokens.origin_host.includes("://")
        ? new URL(tokens.origin_host).origin
        : `https://${tokens.origin_host}`;
      if (origin !== this.serverOrigin) reject();
      const current = await scope.fetch(
        `${this.serverOrigin}/api/${this.apiVersion}/sessions/current`,
        { headers: { "X-Tableau-Auth": tokens.access_token, accept: "application/json" }, signal },
      );
      if (!current.ok) reject();
      const session = sessionSchema.parse(await current.json()).session;
      if (session.site.id !== this.expectedSiteId) reject();
      return {
        deploymentId: this.deploymentId,
        siteId: session.site.id,
        subjectId: session.user.id,
        verifiedAt: new Date(),
        adapterId: this.id,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      reject();
    } finally {
      await scope.dispose();
    }
  }
}
