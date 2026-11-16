import * as oauth from "oauth4webapi";
import { z } from "zod";
import { ServiceError } from "../platform/errors.ts";

/** What a deployment adapter proves about a Tableau sign-in. */
export type VerifiedTableauUser = {
  siteId: string;
  siteContentUrl: string;
  userId: string;
  userName: string;
  email: string | undefined;
};

export type AuthorizationInput = {
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
};
export type CompletionInput = {
  callback: URLSearchParams;
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  signal?: AbortSignal;
};

/** Implements Tableau sign-in for one deployment kind. A Tableau Server adapter implements the same two steps. */
export interface DeploymentAdapter {
  readonly deploymentId: string;
  authorizationUrl(input: AuthorizationInput): URL;
  complete(input: CompletionInput): Promise<VerifiedTableauUser>;
}

/** Tableau's central sign-in service for Tableau Cloud. */
export const TABLEAU_CLOUD_METADATA: oauth.AuthorizationServer = Object.freeze({
  issuer: "https://sso.online.tableau.com",
  authorization_endpoint: "https://sso.online.tableau.com/oauth2/authorize",
  token_endpoint: "https://sso.online.tableau.com/oauth2/token",
  userinfo_endpoint: "https://sso.online.tableau.com/userinfo",
  jwks_uri: "https://sso.online.tableau.com/oauth2/jwks",
  id_token_signing_alg_values_supported: ["ES256"],
});

/** Where the service publishes its own OAuth client metadata document; the document's URL is the client ID. */
export const TABLEAU_CLIENT_PATH = "/tableau/client.json";
/** Where Tableau returns the browser after sign-in. */
export const TABLEAU_CALLBACK_PATH = "/tableau/callback";

/**
 * The service's OAuth client metadata document for Tableau's central sign-in service.
 * Tableau resolves the client by fetching this document from the client ID URL, so no client is registered in advance.
 */
export function tableauClientMetadata(publicOrigin: string) {
  return {
    client_id: `${publicOrigin}${TABLEAU_CLIENT_PATH}`,
    client_name: "Data App integration service",
    redirect_uris: [`${publicOrigin}${TABLEAU_CALLBACK_PATH}`],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: "openid email",
  };
}

const currentSession = z.object({
  session: z.object({
    site: z.object({ id: z.string().min(1).max(200), contentUrl: z.string().max(255) }),
    user: z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(500) }),
  }),
});

const UNAVAILABLE = new Set([
  "upstream-unreachable",
  "upstream-interrupted",
  "upstream-timeout",
  "upstream-tls-failed",
  "destination-refused",
]);

function failed(reason: string): ServiceError {
  return new ServiceError(
    401,
    "identity-verification-failed",
    `Tableau sign-in could not be verified (${reason})`,
  );
}

function unavailable(cause?: unknown): ServiceError {
  return new ServiceError(503, "tableau-unavailable", "Tableau sign-in is unavailable", { cause });
}

export type TableauCloudOptions = {
  deploymentId: string;
  podOrigin: string;
  /** The URL of the service's client metadata document; see `tableauClientMetadata`. */
  clientId: string;
  fetch: typeof fetch;
  /** Overrides Tableau's sign-in metadata; used only by local stand-ins in tests. */
  metadata?: oauth.AuthorizationServer;
};

export class TableauCloudAdapter implements DeploymentAdapter {
  readonly deploymentId: string;
  readonly #podOrigin: string;
  readonly #client: oauth.Client;
  readonly #fetch: typeof fetch;
  readonly #as: oauth.AuthorizationServer;

  constructor(options: TableauCloudOptions) {
    this.deploymentId = options.deploymentId;
    this.#podOrigin = options.podOrigin;
    this.#client = { client_id: options.clientId, id_token_signed_response_alg: "ES256" };
    this.#fetch = options.fetch;
    this.#as = options.metadata ?? TABLEAU_CLOUD_METADATA;
  }

  authorizationUrl(input: AuthorizationInput): URL {
    const url = new URL(this.#as.authorization_endpoint as string);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.#client.client_id,
      redirect_uri: input.redirectUri,
      scope: "openid email",
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return url;
  }

  async complete(input: CompletionInput): Promise<VerifiedTableauUser> {
    // oauth4webapi types customFetch per method; the outbound fetcher handles every method it uses.
    const options: any = {
      [oauth.customFetch]: this.#fetch,
      ...(input.signal ? { signal: input.signal } : {}),
    };
    let parameters: URLSearchParams;
    try {
      parameters = oauth.validateAuthResponse(this.#as, this.#client, input.callback, input.state);
    } catch (error) {
      if (error instanceof oauth.AuthorizationResponseError)
        throw new ServiceError(401, "tableau-sign-in-denied", "Tableau sign-in did not complete");
      throw failed("state");
    }
    const call = async <T>(step: string, fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        if (error instanceof ServiceError && UNAVAILABLE.has(error.code)) throw unavailable(error);
        if (error instanceof oauth.ResponseBodyError && error.status >= 500)
          throw unavailable(error);
        if (error instanceof ServiceError) throw error;
        throw failed(step);
      }
    };
    const response = await call("token", () =>
      oauth.authorizationCodeGrantRequest(
        this.#as,
        this.#client,
        oauth.None(),
        parameters,
        input.redirectUri,
        input.verifier,
        options,
      ),
    );
    if (response.status >= 500) throw unavailable();
    const tokens = await call("id-token", () =>
      oauth.processAuthorizationCodeResponse(this.#as, this.#client, response, {
        expectedNonce: input.nonce,
        requireIdToken: true,
      }),
    );
    await call("signature", () =>
      oauth.validateApplicationLevelSignature(this.#as, response, options),
    );
    const claims = oauth.getValidatedIdTokenClaims(tokens);
    if (!claims) throw failed("id-token");
    if (claims.azp !== undefined && claims.azp !== this.#client.client_id) throw failed("azp");
    if (
      typeof claims.at_hash !== "string" ||
      claims.at_hash !== (await atHash(tokens.access_token))
    )
      throw failed("at-hash");
    const info = await call("userinfo", async () => {
      const r = await oauth.userInfoRequest(this.#as, this.#client, tokens.access_token, options);
      return await oauth.processUserInfoResponse(this.#as, this.#client, claims.sub, r);
    });
    const session = await call("session", async () => {
      const r = await this.#fetch(`${this.#podOrigin}/api/3.24/sessions/current`, {
        headers: { authorization: `Bearer ${tokens.access_token}`, accept: "application/json" },
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (r.status >= 500) throw unavailable();
      if (!r.ok) throw failed("session");
      return currentSession.parse(await r.json()).session;
    });
    const email =
      typeof info.email === "string"
        ? info.email
        : typeof claims.email === "string"
          ? claims.email
          : undefined;
    return {
      siteId: session.site.id,
      siteContentUrl: session.site.contentUrl,
      userId: session.user.id,
      userName: session.user.name,
      email,
    };
  }
}

/** OpenID Connect access token hash for ES256: left half of SHA-256, base64url. */
async function atHash(accessToken: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken)),
  );
  return Buffer.from(digest.subarray(0, 16)).toString("base64url");
}
