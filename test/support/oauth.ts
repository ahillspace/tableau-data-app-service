import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { json, readBody, type StandIn, standIn } from "./https.ts";

export type TokenFaults = {
  /** Refresh grants answer `invalid_grant`. */
  rejectRefresh?: boolean;
  /** Token requests wait this long before answering. */
  delayMs?: number;
  /** Token requests answer with this status and no named error. */
  status?: number;
  /** Token requests destroy the socket after reading the request. */
  drop?: boolean;
};

type Grant = { clientId: string; redirectUri: string; challenge: string; scope: string };

/** A local OAuth 2.0 authorization server and API host, standing in for a provider. */
export class OAuthStandIn {
  readonly clientId = "client-test";
  readonly clientSecret = randomBytes(12).toString("hex");
  faults: TokenFaults = {};
  /** Every token request the provider received, in order. */
  tokenRequests: { grantType: string; authorization: string | undefined; body: URLSearchParams }[] =
    [];
  /** Every API request the provider received. */
  apiRequests: {
    method: string;
    url: string;
    headers: IncomingMessage["headers"];
    rawHeaders: string[];
    body: Buffer;
  }[] = [];
  /** Access token lifetime in seconds for issued tokens. */
  expiresIn = 3600;
  #codes = new Map<string, Grant>();
  #refresh = new Map<string, number>();
  #issued = 0;
  #server: StandIn | undefined;
  apiHandler: ((req: IncomingMessage, res: ServerResponse, body: Buffer) => void) | undefined;

  /** Forgets everything issued and observed, for the next test. */
  reset(): void {
    this.faults = {};
    this.tokenRequests = [];
    this.apiRequests = [];
    this.expiresIn = 3600;
    this.apiHandler = undefined;
    this.#codes.clear();
    this.#refresh.clear();
    this.#issued = 0;
  }

  get origin(): string {
    return (this.#server as StandIn).origin;
  }

  async start(): Promise<this> {
    this.#server = await standIn((req, res) => void this.#handle(req, res));
    return this;
  }

  close(): Promise<void> {
    return this.#server?.close() ?? Promise.resolve();
  }

  /** Simulates a user approving the authorization request; returns the callback query. */
  authorize(url: URL): URLSearchParams {
    const p = url.searchParams;
    const code = randomBytes(12).toString("hex");
    this.#codes.set(code, {
      clientId: p.get("client_id") ?? "",
      redirectUri: p.get("redirect_uri") ?? "",
      challenge: p.get("code_challenge") ?? "",
      scope: p.get("scope") ?? "",
    });
    return new URLSearchParams({ code, state: p.get("state") ?? "" });
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const url = new URL(req.url ?? "/", "https://x");
    if (url.pathname === "/token")
      return await this.#token(req, res, new URLSearchParams(body.toString("utf8")));
    this.apiRequests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      rawHeaders: req.rawHeaders,
      body,
    });
    if (this.apiHandler) return this.apiHandler(req, res, body);
    json(res, 200, { ok: true, path: url.pathname });
  }

  #issue(scope: string): Record<string, unknown> {
    this.#issued++;
    const refresh = `r-${randomBytes(8).toString("hex")}`;
    this.#refresh.set(refresh, this.#issued);
    return {
      access_token: `a-${this.#issued}`,
      token_type: "Bearer",
      expires_in: this.expiresIn,
      refresh_token: refresh,
      scope,
    };
  }

  async #token(req: IncomingMessage, res: ServerResponse, form: URLSearchParams): Promise<void> {
    const grantType = form.get("grant_type") ?? "";
    this.tokenRequests.push({ grantType, authorization: req.headers.authorization, body: form });
    if (this.faults.delayMs) await new Promise((r) => setTimeout(r, this.faults.delayMs));
    if (this.faults.drop) {
      req.socket.destroy();
      return;
    }
    if (this.faults.status) return json(res, this.faults.status, {});
    const expected = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`;
    const postAuth =
      form.get("client_id") === this.clientId && form.get("client_secret") === this.clientSecret;
    if (req.headers.authorization !== expected && !postAuth)
      return json(res, 401, { error: "invalid_client" });
    if (grantType === "authorization_code") {
      const code = form.get("code") ?? "";
      const grant = this.#codes.get(code);
      this.#codes.delete(code);
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (!grant || grant.redirectUri !== form.get("redirect_uri") || grant.challenge !== challenge)
        return json(res, 400, { error: "invalid_grant" });
      return json(res, 200, this.#issue(grant.scope));
    }
    if (grantType === "refresh_token") {
      const token = form.get("refresh_token") ?? "";
      if (this.faults.rejectRefresh || !this.#refresh.has(token))
        return json(res, 400, { error: "invalid_grant" });
      // Rotation: each refresh token works once.
      this.#refresh.delete(token);
      return json(res, 200, this.#issue("read"));
    }
    json(res, 400, { error: "unsupported_grant_type" });
  }
}
