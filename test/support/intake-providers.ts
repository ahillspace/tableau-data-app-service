import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { DefinitionView, DefinitionWrite } from "../../src/contracts/operator.ts";
import { createEvents } from "../../src/events/index.ts";
import type { EventService } from "../../src/events/service.ts";
import { createApi } from "../../src/http/app.ts";
import { JobService } from "../../src/jobs/service.ts";
import { openDatabase } from "../../src/persistence/database.ts";
import { Log } from "../../src/platform/log.ts";
import { Outbound } from "../../src/platform/outbound.ts";
import { NativeRouter } from "../../src/router/router.ts";
import { connectionsHarness } from "./connections.ts";
import { caCert, freshDatabase, testKeys } from "./db.ts";
import { makeCertificates } from "./global.ts";
import { loopback, readBody } from "./https.ts";
import { appSignIn, identityHarness, operatorSignIn, tableauSignIn } from "./identity.ts";
import { TableauStandIn } from "./tableau.ts";

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export type ProviderRequest = {
  method: string;
  url: URL;
  headers: IncomingHttpHeaders;
  body: Buffer;
  form: URLSearchParams;
};
type Reply = {
  status?: number;
  json?: unknown;
  body?: string;
  headers?: Record<string, string>;
  wait?: Promise<void>;
  drop?: boolean;
};

/** A provider oracle, with no service-side protocol execution or credential placement. */
export class IntakeProvider {
  readonly requests: ProviderRequest[] = [];
  readonly failures: unknown[] = [];
  readonly #expected: { path: string; check: (request: ProviderRequest) => void; reply: Reply }[] =
    [];
  #server: Server | undefined;
  #root = "";
  port = 0;

  get origin(): string {
    return `https://localhost:${this.port}`;
  }
  originFor(host: string): string {
    return `https://${host}:${this.port}`;
  }

  async start(): Promise<this> {
    this.#root = mkdtempSync(join(tmpdir(), "intake-provider-"));
    makeCertificates(
      this.#root,
      "localhost",
      [
        "DNS:localhost",
        "DNS:aiplatform.googleapis.com",
        "DNS:us-central1-aiplatform.googleapis.com",
      ].join(","),
    );
    this.#server = createServer(
      {
        key: readFileSync(join(this.#root, "server.key")),
        cert: readFileSync(join(this.#root, "server.crt")),
      },
      (req, res) => {
        void (async () => {
          const body = await readBody(req);
          const request: ProviderRequest = {
            method: req.method ?? "",
            url: new URL(req.url ?? "/", `https://${req.headers.host}`),
            headers: req.headers,
            body,
            form: new URLSearchParams(body.toString("utf8")),
          };
          this.requests.push(request);
          const index = this.#expected.findIndex((entry) => entry.path === request.url.pathname);
          assert.ok(index >= 0, "provider received an unexpected request");
          const expected = this.#expected.splice(index, 1)[0];
          assert.ok(expected);
          expected.check(request);
          await expected.reply.wait;
          if (expected.reply.drop) {
            req.socket.destroy();
            return;
          }
          res.writeHead(expected.reply.status ?? 200, {
            "content-type": expected.reply.json === undefined ? "text/plain" : "application/json",
            ...expected.reply.headers,
          });
          res.end(
            expected.reply.json === undefined
              ? (expected.reply.body ?? "")
              : JSON.stringify(expected.reply.json),
          );
        })().catch((error: unknown) => {
          this.failures.push(error);
          if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
          res.end('{"error":"fixture-rejected-request"}');
        });
      },
    );
    await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
    this.port = (this.#server.address() as AddressInfo).port;
    return this;
  }

  outbound(): Outbound {
    return new Outbound({
      connectTimeoutMs: 2000,
      headersTimeoutMs: 5000,
      idleTimeoutMs: 5000,
      extraCa: [readFileSync(join(this.#root, "ca.crt"), "utf8")],
      resolver: loopback,
    });
  }

  expect(
    path: string,
    check: (request: ProviderRequest) => void,
    reply: Reply = { json: { ok: true } },
  ): void {
    this.#expected.push({ path, check, reply });
  }
  count(path: string): number {
    return this.requests.filter((r) => r.url.pathname === path).length;
  }
  assertComplete(): void {
    assert.deepEqual(this.failures, [], "provider independently accepted every request");
    assert.equal(this.#expected.length, 0, "provider received every expected request exactly once");
  }
  async close(): Promise<void> {
    this.#server?.closeAllConnections();
    await new Promise<void>((resolve) =>
      this.#server ? this.#server.close(() => resolve()) : resolve(),
    );
    if (this.#root) rmSync(this.#root, { recursive: true, force: true });
  }
}

export function signingKey(algorithm: "RS256" | "ES256" = "RS256") {
  const keys =
    algorithm === "RS256"
      ? generateKeyPairSync("rsa", { modulusLength: 2048 })
      : generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** Verify using Node crypto, independently of the production JWT emitter. */
export function verifyJwt(
  token: string,
  expected: {
    key: KeyObject;
    algorithm: "RS256" | "ES256";
    keyId: string;
    issuer: string;
    subject?: string;
    audience: string;
    scope?: string;
    ttl: number;
    jti?: boolean;
  },
): Record<string, unknown> {
  const parts = token.split(".");
  assert.equal(parts.length, 3);
  const [head, payload, signature] = parts as [string, string, string];
  const header = JSON.parse(Buffer.from(head, "base64url").toString());
  assert.equal(header.alg, expected.algorithm);
  assert.equal(header.kid, expected.keyId);
  assert.equal(
    verify(
      "sha256",
      Buffer.from(`${head}.${payload}`),
      {
        key: expected.key,
        ...(expected.algorithm === "ES256" ? { dsaEncoding: "ieee-p1363" as const } : {}),
      },
      Buffer.from(signature, "base64url"),
    ),
    true,
    "provider verifies the JWT signature",
  );
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.equal(claims.iss, expected.issuer);
  assert.equal(claims.sub, expected.subject);
  assert.equal(claims.aud, expected.audience);
  assert.equal(claims.scope, expected.scope);
  const now = Math.floor(Date.now() / 1000);
  assert.ok(Number.isInteger(claims.iat) && Math.abs(claims.iat - now) < 10);
  assert.equal(claims.exp - claims.iat, expected.ttl);
  assert.ok(claims.exp > now && claims.exp <= now + 3600);
  if (expected.jti) assert.ok(typeof claims.jti === "string" && claims.jti.length > 0);
  return claims;
}

export async function intakeHarness(provider: IntakeProvider, eventsEnabled = false) {
  const database = await freshDatabase();
  const tableau = await new TableauStandIn().start();
  const identity = await identityHarness(database.db, tableau);
  const signed = await tableauSignIn(identity, tableau, {
    siteId: "site-a",
    siteContentUrl: "alpha",
    userId: "user-op",
    userName: "op@example.com",
  });
  const operator = await operatorSignIn(identity, signed.cookie);
  const app = await appSignIn(identity, signed.cookie);
  const site = await database.db.selectFrom("trusted_sites").select("id").executeTakeFirstOrThrow();
  const keys = testKeys();
  const outbound = provider.outbound();
  const lines: string[] = [];
  const log = new Log((line) => lines.push(line));
  const replicas: {
    api: FastifyInstance;
    events: EventService | undefined;
    closeDb: () => Promise<void>;
    lines: string[];
  }[] = [];

  async function replica(independentPool = false) {
    const db = independentPool
      ? openDatabase({ url: database.url, caCert: caCert(), applicationName: "intake-replica-b" })
          .db
      : database.db;
    const c = connectionsHarness(db, { keys, outbound, clock: identity.clock });
    const jobs = new JobService({
      db,
      connections: c.connections,
      publicOrigin: "https://service.test",
      clock: identity.clock,
      log,
      limits: {
        inputBytes: 4096,
        resultBytes: 4096,
        runtimeSeconds: 3600,
        resultRetentionSeconds: 86400,
        recordRetentionSeconds: 86400,
      },
    });
    const events = await createEvents({
      redisUrl: eventsEnabled ? process.env.TDAS_TEST_REDIS : undefined,
      connections: c.connections,
      clock: identity.clock,
      log,
      sessionValid: (p) => identity.identity.sessionActive(p.sessionId),
    });
    await events?.start();
    const api = await createApi({
      db,
      publicOrigin: "https://service.test",
      identity: identity.identity,
      connections: c.connections,
      router: new NativeRouter({ connections: c.connections, outbound, log }),
      jobs,
      events,
      log,
    });
    await api.listen({ port: 0, host: "127.0.0.1" });
    const origin = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
    replicas.push({
      api,
      events,
      closeDb: independentPool ? () => db.destroy() : async () => {},
      lines: c.lines,
    });
    const request = (
      path: string,
      options: RequestInit & { json?: unknown; bearer?: string } = {},
    ) => {
      const { json, bearer = operator.bearer, ...init } = options;
      const headers = new Headers(init.headers);
      headers.set("Tableau-Service-Authorization", `Bearer ${bearer}`);
      if (json !== undefined) headers.set("content-type", "application/json");
      return fetch(`${origin}${path}`, {
        ...init,
        headers,
        redirect: "manual",
        signal: init.signal ?? AbortSignal.timeout(15_000),
        ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      });
    };
    const native = (id: string, path = "/native", host?: string) =>
      request(`/v1/native/${id}${path}`, {
        bearer: app.bearer,
        ...(host ? { headers: { "Tableau-Service-Host": host } } : {}),
      });
    return { ...c, db, api, origin, events, request, native };
  }
  const first = await replica();
  return {
    ...first,
    app,
    operator,
    identity,
    lines,
    siteId: site.id,
    cookie: `__Host-tdas-sign-in=${signed.cookie}`,
    replica: () => replica(true),
    definition(id: string, override: Partial<DefinitionWrite> = {}): DefinitionWrite {
      return {
        id,
        displayName: id,
        ownership: "shared",
        apiHosts: [provider.origin],
        authentication: { method: "none" },
        credentialPlacement: { kind: "bearer" },
        scopes: [],
        audience: [site.id],
        privateHosts: true,
        enabled: true,
        ...override,
      };
    },
    async create(definition: DefinitionWrite): Promise<DefinitionView> {
      const response = await first.request("/v1/admin/definitions", {
        method: "POST",
        json: definition,
      });
      assert.equal(response.status, 201, await response.clone().text());
      return (await response.json()).definition;
    },
    async view(id: string): Promise<DefinitionView> {
      const response = await first.request(`/v1/admin/definitions/${id}`);
      assert.equal(response.status, 200);
      return (await response.json()).definition;
    },
    async assertSafe(secrets: string[], responses: string[] = []): Promise<void> {
      const audit = await first.request("/v1/admin/audit?limit=200");
      assert.equal(audit.status, 200);
      const observed = [
        ...lines,
        ...identity.lines,
        ...replicas.flatMap((r) => r.lines),
        ...responses,
        await audit.text(),
      ].join("\n");
      assert.ok(observed.length > 0);
      for (const secret of secrets)
        assert.equal(
          observed.includes(secret),
          false,
          "exercised responses/logs/audit exclude fixture secrets",
        );
    },
    async close(): Promise<void> {
      for (const r of replicas.reverse()) {
        await r.api.close();
        await r.events?.close();
        await r.closeDb();
      }
      await outbound.close();
      await identity.close();
      await tableau.close();
      await database.close();
    },
  };
}

export type IntakeHarness = Awaited<ReturnType<typeof intakeHarness>>;

export const tokenResponse = {
  format: "json" as const,
  rules: { successStatuses: [200], failure: [{ path: ["ok"], equals: false }] },
  mapping: { accessToken: ["access_token"], expiresIn: ["expires_in"] },
};
