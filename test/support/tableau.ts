/**
 * A local stand-in for Tableau's central sign-in service and a pod's REST API.
 * It issues ES256 ID tokens, checks PKCE and the client, and answers sessions/current.
 * Like Tableau, it knows the client only through the client's metadata document, which `authorize` is given.
 */
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import type * as oauth from "oauth4webapi";
import { json, readBody, type StandIn, standIn } from "./https.ts";

const SERVICE_ORIGIN = "https://service.test";

export type TableauUser = {
  siteId: string;
  siteContentUrl: string;
  userId: string;
  userName: string;
  email?: string;
};

export type Faults = {
  nonce?: boolean;
  signature?: boolean;
  atHash?: "missing" | "wrong";
  audience?: boolean;
  userinfoSubject?: boolean;
  sessionStatus?: number;
  tokenStatus?: number;
};

type Pending = {
  user: TableauUser;
  challenge: string;
  clientId: string;
  redirectUri: string;
  nonce: string;
};

const b64 = (value: Buffer | string) => Buffer.from(value).toString("base64url");

export class TableauStandIn {
  server!: StandIn;
  /** The service's client ID in tests: its metadata document URL under the test public origin. */
  readonly clientId: string;
  faults: Faults = {};
  readonly #codes = new Map<string, Pending>();
  readonly #tokens = new Map<string, { user: TableauUser; sub: string }>();
  readonly #key: KeyObject;
  readonly #other: KeyObject;
  readonly #jwk: Record<string, unknown>;
  tokenCalls = 0;

  constructor(serviceOrigin = SERVICE_ORIGIN) {
    this.clientId = `${serviceOrigin}/tableau/client.json`;
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.#key = pair.privateKey;
    this.#other = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    this.#jwk = {
      ...pair.publicKey.export({ format: "jwk" }),
      kid: "k1",
      alg: "ES256",
      use: "sig",
    };
  }

  async start(): Promise<this> {
    this.server = await standIn((req, res) => {
      void this.#handle(req, res).catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
    return this;
  }

  get origin(): string {
    return this.server.origin;
  }

  get metadata(): oauth.AuthorizationServer {
    return {
      issuer: this.origin,
      authorization_endpoint: `${this.origin}/oauth2/authorize`,
      token_endpoint: `${this.origin}/oauth2/token`,
      userinfo_endpoint: `${this.origin}/userinfo`,
      jwks_uri: `${this.origin}/oauth2/jwks`,
      id_token_signing_alg_values_supported: ["ES256"],
    };
  }

  /**
   * Plays the browser at Tableau: the user signs in and Tableau redirects back with a code.
   * When given the client's metadata document, it refuses a client ID or redirect URL the document does not name, as Tableau does.
   */
  authorize(
    authorizationUrl: URL | string,
    user: TableauUser,
    client?: { client_id: string; redirect_uris: string[] },
  ): URLSearchParams {
    const url = new URL(authorizationUrl);
    const p = url.searchParams;
    if (p.get("scope") !== "openid email" || p.get("code_challenge_method") !== "S256")
      throw new Error("bad authorize request");
    if (
      client &&
      (p.get("client_id") !== client.client_id ||
        !client.redirect_uris.includes(p.get("redirect_uri") ?? ""))
    )
      throw new Error("client metadata does not match the authorize request");
    const code = b64(randomBytes(24));
    this.#codes.set(code, {
      user,
      challenge: p.get("code_challenge") ?? "",
      clientId: p.get("client_id") ?? "",
      redirectUri: p.get("redirect_uri") ?? "",
      nonce: p.get("nonce") ?? "",
    });
    return new URLSearchParams({ code, state: p.get("state") ?? "" });
  }

  #idToken(claims: Record<string, unknown>): string {
    const header = b64(JSON.stringify({ alg: "ES256", kid: "k1", typ: "JWT" }));
    const payload = b64(JSON.stringify(claims));
    const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
      key: this.faults.signature ? this.#other : this.#key,
      dsaEncoding: "ieee-p1363",
    });
    return `${header}.${payload}.${b64(signature)}`;
  }

  async #handle(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", this.origin);
    if (url.pathname === "/oauth2/jwks") return json(res, 200, { keys: [this.#jwk] });
    if (url.pathname === "/oauth2/token" && req.method === "POST") {
      this.tokenCalls++;
      const form = new URLSearchParams((await readBody(req)).toString());
      if (this.faults.tokenStatus)
        return json(res, this.faults.tokenStatus, { error: "server_error" });
      const pending = this.#codes.get(form.get("code") ?? "");
      this.#codes.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      if (
        !pending ||
        form.get("grant_type") !== "authorization_code" ||
        form.get("client_id") !== pending.clientId ||
        pending.clientId !== this.clientId ||
        form.get("redirect_uri") !== pending.redirectUri ||
        createHash("sha256").update(verifier).digest("base64url") !== pending.challenge
      )
        return json(res, 400, { error: "invalid_grant" });
      const access = b64(randomBytes(24));
      const sub = `sub-${pending.user.userId}`;
      this.#tokens.set(access, { user: pending.user, sub });
      const now = Math.floor(Date.now() / 1000);
      const claims: Record<string, unknown> = {
        iss: this.origin,
        aud: this.faults.audience ? "someone-else" : this.clientId,
        sub,
        iat: now,
        exp: now + 300,
        nonce: this.faults.nonce ? "wrong" : pending.nonce,
        email: pending.user.email,
      };
      if (this.faults.atHash !== "missing")
        claims.at_hash =
          this.faults.atHash === "wrong"
            ? "AAAAAAAAAAAAAAAAAAAAAA"
            : b64(createHash("sha256").update(access).digest().subarray(0, 16));
      return json(res, 200, {
        access_token: access,
        token_type: "Bearer",
        expires_in: 300,
        id_token: this.#idToken(claims),
      });
    }
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const token = this.#tokens.get(bearer);
    if (url.pathname === "/userinfo") {
      if (!token) return json(res, 401, {});
      return json(res, 200, {
        sub: this.faults.userinfoSubject ? "other" : token.sub,
        email: token.user.email,
      });
    }
    if (url.pathname === "/api/3.24/sessions/current") {
      if (this.faults.sessionStatus) return json(res, this.faults.sessionStatus, {});
      if (!token) return json(res, 401, {});
      const u = token.user;
      return json(res, 200, {
        session: {
          site: { id: u.siteId, name: u.siteContentUrl, contentUrl: u.siteContentUrl },
          user: { id: u.userId, name: u.userName },
        },
      });
    }
    res.writeHead(404);
    res.end();
  }

  close(): Promise<void> {
    return this.server.close();
  }
}
