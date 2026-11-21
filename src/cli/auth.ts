import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { pkceChallenge, randomToken } from "../platform/secrets.ts";
import { canonicalOrigin } from "../platform/settings.ts";
import type { SecretInput } from "./secret-input.ts";

const BEARER_HEADER = "Tableau-Service-Authorization";
const LOGIN_TIMEOUT_MS = 5 * 60_000;
export type Mode = "operator" | "viewer";
export type Options = Map<string, string[]>;

/** Where the CLI keeps the service origin and signed-in bearers for it. */
export type CredentialStore = {
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
};

export type CliDeps = {
  fetch: typeof fetch;
  store: CredentialStore;
  /** Opens a URL in the user's browser. */
  open(url: string): Promise<void>;
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
  secretInput?: SecretInput;
};

export class UsageError extends Error {}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly mode: Mode;
  constructor(status: number, body: unknown, mode: Mode = "operator") {
    const error = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
    super(error?.message ?? `The service answered ${status}`);
    this.status = status;
    this.body = body;
    this.mode = mode;
  }
}

export class Client {
  readonly origin: string;
  readonly #deps: CliDeps;
  readonly #bearer: string | undefined;
  readonly #mode: Mode;

  constructor(deps: CliDeps, origin: string, bearer: string | undefined, mode: Mode = "operator") {
    this.#deps = deps;
    this.origin = origin;
    this.#bearer = bearer;
    this.#mode = mode;
  }

  async call<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.#bearer) headers[BEARER_HEADER] = `Bearer ${this.#bearer}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await this.#deps.fetch(`${this.origin}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: "manual",
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!response.ok) throw new ApiError(response.status, parsed, this.#mode);
    return parsed as T;
  }
}

const currentAccount = (mode: Mode) =>
  mode === "viewer" ? "viewer-current-service" : "current-service";
const loginCommand = (mode: Mode) => (mode === "viewer" ? "tdas login --viewer" : "tdas login");

export const credentialAccount = (origin: string, mode: Mode) =>
  mode === "viewer" ? `viewer:${origin}` : origin;

export async function serviceOrigin(
  deps: CliDeps,
  options: Options,
  mode: Mode = "operator",
  configuredOrigin?: string,
): Promise<string> {
  const given =
    options.get("service")?.at(-1) ??
    deps.env.TDAS_SERVICE ??
    configuredOrigin ??
    (await deps.store.get(currentAccount(mode)));
  if (!given) throw new UsageError(`No service: run ${loginCommand(mode)} --service <origin>`);
  const origin = canonicalOrigin(given.replace(/\/$/, ""));
  if (!origin) throw new UsageError("--service must be an HTTPS origin, or HTTP on loopback");
  return origin;
}

export async function signedIn(
  deps: CliDeps,
  options: Options,
  mode: Mode = "operator",
  configuredOrigin?: string,
): Promise<Client> {
  const origin = await serviceOrigin(deps, options, mode, configuredOrigin);
  const bearer = await deps.store.get(credentialAccount(origin, mode));
  if (!bearer) throw new UsageError(`Not signed in to ${origin}: run ${loginCommand(mode)}`);
  return new Client(deps, origin, bearer, mode);
}

type Token = { bearer: string; session: unknown };

/** Both flows return a one-time code to the same local listener and redeem it with PKCE. */
export async function login(deps: CliDeps, origin: string, mode: Mode): Promise<void> {
  const verifier = randomToken();
  const state = randomToken();
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const server = createServer((request, response) => {
    const url = URL.parse(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url?.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code");
    const ok = !!code && url.searchParams.get("state") === state;
    response.writeHead(ok ? 200 : 400, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(
      ok
        ? "Sign-in response received. You can close this window and return to the terminal.\n"
        : "This request did not match the command-line sign-in.\n",
    );
    if (ok) resolve(code);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { port } = server.address() as AddressInfo;
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const proofHash = pkceChallenge(verifier);
    const client = new Client(deps, origin, undefined, mode);
    let url: string;
    let redeem: (code: string) => Promise<Token>;
    if (mode === "viewer") {
      const started = await client.call<{ transactionId: string; url: string }>(
        "POST",
        "/v1/app-sign-ins",
        { appId: "tdas-cli", proofHash, loopback: { redirectUri, state } },
      );
      const id = encodeURIComponent(started.transactionId);
      const signInUrl = new URL(started.url, origin);
      if (signInUrl.origin !== origin || signInUrl.username || signInUrl.password)
        throw new Error("Viewer sign-in returned a URL outside the service origin");
      url = signInUrl.href;
      redeem = (code) =>
        client.call("POST", `/v1/app-sign-ins/${id}/redeem`, { code, proof: verifier });
    } else {
      const query = new URLSearchParams({
        redirect_uri: redirectUri,
        code_challenge: proofHash,
        state,
      });
      url = `${origin}/operator-sign-in?${query}`;
      redeem = (code) => client.call("POST", "/v1/operator-sign-ins/token", { code, verifier });
    }
    deps.err(`Opening ${url}`);
    timer = setTimeout(
      () => reject(new Error("Timed out waiting for the browser sign-in")),
      LOGIN_TIMEOUT_MS,
    );
    const [code] = await Promise.all([promise, Promise.resolve().then(() => deps.open(url))]);
    const token = await redeem(code);
    if (typeof token?.bearer !== "string" || !token.bearer)
      throw new Error("Sign-in did not return a bearer");
    await deps.store.set(credentialAccount(origin, mode), token.bearer);
    await deps.store.set(currentAccount(mode), origin);
    deps.out(JSON.stringify({ service: origin, session: token.session }, null, 2));
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
