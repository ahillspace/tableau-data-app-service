#!/usr/bin/env node
/**
 * The operator command-line tool. It signs in with a loopback redirect and PKCE, keeps the operator
 * bearer in the system credential store, and drives the operator API. It holds no business rules:
 * every command is one or two operator API calls.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { CredentialInput, DefinitionView } from "../contracts/operator.ts";
import { pkceChallenge, randomToken } from "../platform/secrets.ts";
import { canonicalOrigin } from "../platform/settings.ts";
import { readSecret, type SecretInput, SecretInputError } from "./secret-input.ts";

const KEYRING_SERVICE = "tableau-data-app-service";
const CURRENT = "current-service";
const BEARER_HEADER = "Tableau-Service-Authorization";
const LOGIN_TIMEOUT_MS = 5 * 60_000;

/** Where the CLI keeps the service origin and the operator bearer for it. */
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

/** The system credential store. The native module loads only when a command needs it. */
export function keyringStore(): CredentialStore {
  const entry = async (account: string) =>
    new (await import("@napi-rs/keyring")).AsyncEntry(KEYRING_SERVICE, account);
  return {
    get: async (account) => (await (await entry(account)).getPassword()) ?? undefined,
    set: async (account, value) => (await entry(account)).setPassword(value),
    delete: async (account) => {
      await (await entry(account)).deletePassword();
    },
  };
}

export function openInBrowser(url: string): Promise<void> {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    const child = spawn(command as string, args as string[], { stdio: "ignore", detached: true });
    // The URL is always printed too, so a missing opener is not an error.
    child.once("error", () => resolve());
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

const USAGE = `Usage: tdas <command>

  login --service <origin>                 Sign in as an operator in the browser
  logout                                   Forget the stored operator bearer
  whoami                                   Show the signed-in operator

  definitions list
  definitions show <id>
  definitions create <file.json>
  definitions secret <id> <field>          Set a write-only clientSecret, signingSecret, signingPrivateKey or credential
  definitions connect <id>                 Shared OAuth connect in the browser
  definitions update <id> [<changes.json>] [--audience add|remove <site>] [--enable] [--disable]
  definitions redefine <id> <file.json>    Ends existing connections
  definitions retire <id>                  Ends existing connections

  connections list [--definition <id>] [--status <status>]
  connections disconnect <connectionId>

  sites list
  sites add <deployment> <content-url>
  sites enable|disable|remove <site>

  operators list
  operators add <deployment> <site-content-url> <username>
  operators remove <operatorId>

  apps
  jobs list [--state <state>] [--handler <name>]
  jobs cancel <jobId>
  sessions revoke <deployment:siteId:userId>
  audit [--limit <n>] [--before <id>]

Options:
  --service <origin>   Service to use; defaults to TDAS_SERVICE, then the last login
  --from-file <path>   Read the secret from a file (preserves newlines)
  --value <value>      Read a secret from the command argument (exposure warning)
  --clear              Explicitly clear the selected secret`;

class UsageError extends Error {}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    const error = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
    super(error?.message ?? `The service answered ${status}`);
    this.status = status;
    this.body = body;
  }
}

/** Splits `--name value` and `--flag` options from positional arguments. */
function parse(argv: string[]): { positional: string[]; options: Map<string, string[]> } {
  const positional: string[] = [];
  const options = new Map<string, string[]>();
  const valued = new Set([
    "service",
    "audience",
    "definition",
    "status",
    "state",
    "handler",
    "limit",
    "before",
    "from-file",
    "value",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const values = options.get(name) ?? [];
    if (name === "audience") {
      const op = argv[++i];
      const site = argv[++i];
      if ((op !== "add" && op !== "remove") || !site)
        throw new UsageError("--audience takes add or remove and a site");
      values.push(`${op}:${site}`);
    } else if (valued.has(name)) {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      values.push(value);
    } else if (name === "enable" || name === "disable" || name === "clear") values.push("");
    else throw new UsageError(`Unknown option --${name}`);
    options.set(name, values);
  }
  return { positional, options };
}

class Client {
  readonly origin: string;
  readonly #deps: CliDeps;
  readonly #bearer: string | undefined;

  constructor(deps: CliDeps, origin: string, bearer: string | undefined) {
    this.#deps = deps;
    this.origin = origin;
    this.#bearer = bearer;
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
    if (!response.ok) throw new ApiError(response.status, parsed);
    return parsed as T;
  }
}

async function serviceOrigin(deps: CliDeps, options: Map<string, string[]>): Promise<string> {
  const given =
    options.get("service")?.at(-1) ?? deps.env.TDAS_SERVICE ?? (await deps.store.get(CURRENT));
  if (!given) throw new UsageError("No service: run tdas login --service <origin>");
  const origin = canonicalOrigin(given.replace(/\/$/, ""));
  if (!origin) throw new UsageError("--service must be an HTTPS origin, or HTTP on loopback");
  return origin;
}

async function signedIn(deps: CliDeps, options: Map<string, string[]>): Promise<Client> {
  const origin = await serviceOrigin(deps, options);
  const bearer = await deps.store.get(origin);
  if (!bearer) throw new UsageError(`Not signed in to ${origin}: run tdas login`);
  return new Client(deps, origin, bearer);
}

/** The loopback sign-in: a one-shot listener on 127.0.0.1, PKCE, and a code redeemed with the verifier. */
async function login(deps: CliDeps, origin: string): Promise<void> {
  const verifier = randomToken();
  const state = randomToken();
  let settle: { resolve(code: string): void; reject(error: Error): void } | undefined;
  const received = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code");
    const ok = code !== null && url.searchParams.get("state") === state;
    response.writeHead(ok ? 200 : 400, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(
      ok
        ? "Signed in. You can close this window and return to the terminal.\n"
        : "Sign-in failed.\n",
    );
    if (ok) settle?.resolve(code);
    else settle?.reject(new Error("The sign-in redirect did not match this login"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const timer = setTimeout(
    () => settle?.reject(new Error("Timed out waiting for the browser sign-in")),
    LOGIN_TIMEOUT_MS,
  );
  try {
    const port = (server.address() as AddressInfo).port;
    const query = new URLSearchParams({
      redirect_uri: `http://127.0.0.1:${port}/callback`,
      code_challenge: pkceChallenge(verifier),
      state,
    });
    const url = `${origin}/operator-sign-in?${query}`;
    deps.err(`Opening ${url}`);
    await deps.open(url);
    const code = await received;
    const token = await new Client(deps, origin, undefined).call<{
      bearer: string;
      session: unknown;
    }>("POST", "/v1/operator-sign-ins/token", { code, verifier });
    await deps.store.set(origin, token.bearer);
    await deps.store.set(CURRENT, origin);
    deps.out(JSON.stringify({ service: origin, session: token.session }, null, 2));
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function readJson(path: string | undefined): Promise<unknown> {
  if (!path) throw new UsageError("A JSON file is required");
  const text = path === "-" ? await readStdin() : await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`${path} is not valid JSON`);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

type Site = { id: string; deploymentId: string; contentUrl: string };

/** A site named by its ID or by its content URL, when that is unambiguous. */
async function resolveSite(client: Client, name: string): Promise<Site> {
  const { sites } = await client.call<{ sites: Site[] }>("GET", "/v1/admin/sites");
  const byId = sites.find((s) => s.id === name);
  if (byId) return byId;
  const matches = sites.filter((s) => s.contentUrl === name);
  if (matches.length === 1) return matches[0] as Site;
  if (matches.length > 1)
    throw new UsageError(`${name} names sites on several deployments; use the site ID`);
  throw new UsageError(`No trusted site ${name}`);
}

const need = (value: string | undefined, what: string): string => {
  if (!value) throw new UsageError(`Missing ${what}`);
  return value;
};

const enc = encodeURIComponent;

async function run(argv: string[], deps: CliDeps): Promise<void> {
  const { positional, options } = parse(argv);
  const [group, action, ...rest] = positional;
  const print = (value: unknown) => deps.out(JSON.stringify(value, null, 2));
  const flag = (name: string) => options.get(name)?.at(-1);
  const filters = (names: string[]) => {
    const q = new URLSearchParams();
    for (const name of names) {
      const value = flag(name);
      if (value !== undefined) q.set(name, value);
    }
    const s = q.toString();
    return s ? `?${s}` : "";
  };

  switch (group) {
    case "login":
      return await login(deps, await serviceOrigin(deps, options));
    case "logout": {
      const origin = await serviceOrigin(deps, options);
      await deps.store.delete(origin);
      deps.err(`Signed out of ${origin}`);
      return;
    }
    case "whoami":
      return print(await (await signedIn(deps, options)).call("GET", "/v1/session"));
    case "apps":
      return print(await (await signedIn(deps, options)).call("GET", "/v1/admin/apps"));
    case "audit":
      return print(
        await (await signedIn(deps, options)).call(
          "GET",
          `/v1/admin/audit${filters(["limit", "before"])}`,
        ),
      );
  }

  const client = await signedIn(deps, options);
  const key = `${group ?? ""} ${action ?? ""}`;
  const [first, second, third] = rest;
  switch (key) {
    case "definitions list":
      return print(await client.call("GET", "/v1/admin/definitions"));
    case "definitions show":
      return print(
        await client.call("GET", `/v1/admin/definitions/${enc(need(first, "definition ID"))}`),
      );
    case "definitions create":
      return print(await client.call("POST", "/v1/admin/definitions", await readJson(first)));
    case "definitions secret": {
      const id = need(first, "definition ID"),
        field = need(second, "secret field");
      if (!["clientSecret", "signingSecret", "signingPrivateKey", "credential"].includes(field))
        throw new UsageError("Unknown secret field");
      const { definition } = await client.call<{ definition: DefinitionView }>(
        "GET",
        `/v1/admin/definitions/${enc(id)}`,
      );
      const value = await readSecret(options, deps.err, deps.secretInput);
      let credential: CredentialInput | null = null;
      if (field === "credential" && value !== null) {
        if (definition.credentialImport) credential = { kind: "import", value };
        else if (
          definition.authentication.method === "static" &&
          definition.credentialPlacement.kind !== "basic"
        )
          credential = { kind: "token", value };
        else {
          let parsed: unknown;
          try {
            parsed = JSON.parse(value);
          } catch {
            throw new UsageError("The credential needs a JSON object");
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new UsageError("The credential needs a JSON object");
          credential = {
            ...parsed,
            kind: definition.credentialPlacement.kind === "basic" ? "basic" : "jwt",
          } as CredentialInput;
        }
      }
      return print(
        await client.call("PUT", `/v1/admin/definitions/${enc(id)}/secrets`, {
          expectedVersion: definition.version,
          ...(field === "credential" ? { credential } : { secrets: { [field]: value } }),
        }),
      );
    }
    case "definitions connect": {
      const started = await client.call<{ url: string; expiresAt: string }>(
        "POST",
        `/v1/admin/definitions/${enc(need(first, "definition ID"))}/connect`,
      );
      deps.err("Approve the shared connection in the browser:");
      deps.out(started.url);
      return await deps.open(started.url);
    }
    case "definitions update": {
      const id = need(first, "definition ID");
      const changes = (second ? await readJson(second) : {}) as Record<string, unknown>;
      if (typeof changes !== "object" || changes === null || Array.isArray(changes))
        throw new UsageError("The changes file must hold a JSON object");
      const { definition: current } = await client.call<{ definition: DefinitionView }>(
        "GET",
        `/v1/admin/definitions/${enc(id)}`,
      );
      const audienceOps = options.get("audience") ?? [];
      if (audienceOps.length) {
        const definition = current;
        const audience = new Set(
          Array.isArray(changes.audience) ? (changes.audience as string[]) : definition.audience,
        );
        for (const op of audienceOps) {
          const [verb, ...site] = op.split(":");
          const resolved = await resolveSite(client, site.join(":"));
          if (verb === "add") audience.add(resolved.id);
          else audience.delete(resolved.id);
        }
        changes.audience = [...audience];
      }
      if (options.has("enable")) changes.enabled = true;
      if (options.has("disable")) changes.enabled = false;
      if (!Object.keys(changes).length) throw new UsageError("Nothing to change");
      return print(
        await client.call("PATCH", `/v1/admin/definitions/${enc(id)}`, {
          ...changes,
          expectedVersion: current.version,
        }),
      );
    }
    case "definitions redefine": {
      const id = need(first, "definition ID");
      const { definition } = await client.call<{ definition: DefinitionView }>(
        "GET",
        `/v1/admin/definitions/${enc(id)}`,
      );
      const body = await readJson(second);
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new UsageError("The definition file must hold a JSON object");
      return print(
        await client.call("PUT", `/v1/admin/definitions/${enc(id)}`, {
          ...body,
          expectedVersion: definition.version,
        }),
      );
    }
    case "definitions retire": {
      const id = need(first, "definition ID");
      const { definition } = await client.call<{ definition: DefinitionView }>(
        "GET",
        `/v1/admin/definitions/${enc(id)}`,
      );
      return print(
        await client.call("POST", `/v1/admin/definitions/${enc(id)}/retire`, {
          expectedVersion: definition.version,
        }),
      );
    }

    case "connections list":
      return print(
        await client.call(
          "GET",
          `/v1/admin/connections${filters(["definition", "status", "limit"])}`,
        ),
      );
    case "connections disconnect":
      return print(
        await client.call("DELETE", `/v1/admin/connections/${enc(need(first, "connection ID"))}`),
      );

    case "sites list":
      return print(await client.call("GET", "/v1/admin/sites"));
    case "sites add":
      return print(
        await client.call("POST", "/v1/admin/sites", {
          deploymentId: need(first, "deployment ID"),
          contentUrl: second ?? need(undefined, "site content URL"),
        }),
      );
    case "sites enable":
    case "sites disable": {
      const site = await resolveSite(client, need(first, "site"));
      return print(
        await client.call("PATCH", "/v1/admin/sites", {
          id: site.id,
          enabled: action === "enable",
        }),
      );
    }
    case "sites remove": {
      const site = await resolveSite(client, need(first, "site"));
      return print(await client.call("DELETE", "/v1/admin/sites", { id: site.id }));
    }

    case "operators list":
      return print(await client.call("GET", "/v1/admin/operators"));
    case "operators add":
      return print(
        await client.call("POST", "/v1/admin/operators", {
          deploymentId: need(first, "deployment ID"),
          siteContentUrl: need(second, "site content URL"),
          username: need(third, "username"),
        }),
      );
    case "operators remove":
      return print(
        await client.call("DELETE", "/v1/admin/operators", { id: need(first, "operator ID") }),
      );

    case "jobs list":
      return print(
        await client.call("GET", `/v1/admin/jobs${filters(["state", "handler", "limit"])}`),
      );
    case "jobs cancel":
      return print(
        await client.call("POST", `/v1/admin/jobs/${enc(need(first, "Job ID"))}/cancel`),
      );
    case "sessions revoke":
      return print(
        await client.call(
          "POST",
          `/v1/admin/identities/${enc(need(first, "identity key"))}/revoke-sessions`,
        ),
      );
  }
  throw new UsageError(group ? `Unknown command: ${positional.join(" ")}` : "");
}

/** Runs one command and returns its exit code. */
export async function tdas(argv: string[], deps: CliDeps): Promise<number> {
  if (argv[0] === "help" || argv.includes("--help") || argv.length === 0) {
    deps.out(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  try {
    await run(argv, deps);
    return 0;
  } catch (error) {
    if (error instanceof UsageError || error instanceof SecretInputError) {
      deps.err(error.message ? `${error.message}\n\n${USAGE}` : USAGE);
      return 2;
    }
    if (error instanceof ApiError) {
      deps.err(JSON.stringify(error.body ?? { error: { message: error.message } }, null, 2));
      if (error.status === 401) deps.err("Sign in again with tdas login.");
      return 1;
    }
    deps.err((error as Error).message);
    return 1;
  }
}

if (import.meta.main)
  process.exitCode = await tdas(process.argv.slice(2), {
    fetch,
    store: keyringStore(),
    open: openInBrowser,
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    env: process.env,
  });
