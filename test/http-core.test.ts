import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { z } from "zod";
import { ConnectionService } from "../src/connections/service.js";
import { createHttpApp } from "../src/http/app.js";
import { registerCoreRoutes } from "../src/http/core-routes.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { slackRegistration } from "../src/providers/slack.js";
import { decodeControl, encodeControl } from "../src/public/headers.js";
import { candidate, coreFixture, fixtureProvider } from "./core-fixture.js";

test("real API streams native bytes and carriers and invokes ordinary JSON/native handlers without a Jobs schema", async () => {
  const f = await coreFixture();
  let providerCalls = 0;
  const upstream = createServer((request, response) => {
    providerCalls++;
    assert.equal(request.headers.authorization, "Bearer secret-one");
    assert.equal(request.headers["x-integration-method"], undefined);
    if (request.url === "/api/redirect") {
      response.writeHead(307, {
        location: "https://untrusted.example/",
        "x-integration-origin": "service",
      });
      response.end("observable redirect");
      return;
    }
    if (request.method === "HEAD") {
      response.writeHead(200, { "content-length": "200", "content-encoding": "gzip" });
      response.end();
      return;
    }
    request.pipe(response);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing upstream port");
  const provider = {
    ...fixtureProvider,
    endpoints: {
      api: {
        baseUrl: `http://127.0.0.1:${address.port}/api`,
        privateCidrs: ["127.0.0.1/32"],
        allowHttp: true,
      },
    },
    capabilities: [
      {
        ref: { id: "sum", version: 1 },
        providerRegistrationId: "fixture",
        http: {
          input: {
            kind: "json" as const,
            schema: z.strictObject({ a: z.number(), b: z.number() }),
          },
          response: { kind: "json" as const, schema: z.strictObject({ sum: z.number() }) },
          handler: async (input: unknown) => {
            const { a, b } = input as { a: number; b: number };
            return { sum: a + b };
          },
        },
      },
      {
        ref: { id: "native", version: 1 },
        providerRegistrationId: "fixture",
        http: {
          input: { kind: "http" as const },
          response: { kind: "http" as const },
          handler: async () =>
            new Response("handler says conflict", {
              status: 409,
              headers: { "x-integration-origin": "provider" },
            }),
        },
      },
      {
        ref: { id: "redirect", version: 1 },
        providerRegistrationId: "fixture",
        http: {
          input: { kind: "http" as const },
          response: { kind: "http" as const },
          handler: async () =>
            new Response("handler redirect", {
              status: 308,
              headers: { location: "https://example.com/", "x-integration-origin": "provider" },
            }),
        },
      },
    ],
  };
  const registry = new ProviderRegistry([provider]);
  const connections = new ConnectionService(f.db, f.access, f.secrets, registry, {
    maxSockets: 8,
    connectTimeoutMs: 1000,
    headersTimeoutMs: 1000,
    stallTimeoutMs: 1000,
  });
  const connection = await f.credentials.publishLocal(f.alice.access, provider, candidate());
  const app = await createHttpApp({ db: f.db });
  registerCoreRoutes(app, {
    access: f.access,
    connections,
    credentials: f.credentials,
    providers: registry,
    corsOrigins: ["null"],
    jsonPreparationBytes: 1024,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = app.listeningOrigin;
  const headers = {
    authorization: `Bearer ${f.alice.token}`,
    "x-integration-connection": connection.id,
  };
  try {
    const response = await fetch(`${base}/v1/apps/two/proxy/fixture/api/echo`, {
      method: "POST",
      headers: {
        ...headers,
        "x-integration-method": "GET",
        "x-integration-request-headers": encodeControl([
          ["content-type", "application/octet-stream"],
        ]),
      },
      body: "raw bytes",
    });
    assert.equal(response.headers.get("x-integration-origin"), "provider");
    assert.equal(await response.text(), "raw bytes");
    const redirect = await fetch(`${base}/v1/apps/one/proxy/fixture/api/redirect`, {
      headers,
      redirect: "error",
    });
    assert.equal(redirect.status, 200);
    assert.equal(
      (
        decodeControl(redirect.headers.get("x-integration-response-metadata") ?? "") as {
          status: number;
        }
      ).status,
      307,
    );
    assert.equal(await redirect.text(), "observable redirect");
    const head = await fetch(`${base}/v1/apps/one/proxy/fixture/api/object`, {
      method: "POST",
      headers: { ...headers, "x-integration-method": "HEAD" },
      body: "",
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-encoding"), null);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const sum = await fetch(`${base}/v1/apps/one/capabilities/sum/versions/1/invoke`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ a: 2, b: 3 }),
    });
    assert.equal(sum.status, 200);
    assert.deepEqual(await sum.json(), { sum: 5 });
    assert.equal(sum.headers.get("x-integration-origin"), "service");
    const conflict = await fetch(`${base}/v1/apps/one/capabilities/native/versions/1/invoke`, {
      method: "POST",
      headers,
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.headers.get("x-integration-origin"), "service");
    assert.equal(conflict.headers.get("x-integration-error"), null);
    assert.equal(await conflict.text(), "handler says conflict");
    const constructedRedirect = await fetch(
      `${base}/v1/apps/one/capabilities/redirect/versions/1/invoke`,
      { method: "POST", headers, redirect: "error" },
    );
    assert.equal(constructedRedirect.status, 200);
    assert.equal(constructedRedirect.headers.get("x-integration-origin"), "service");
    assert.equal(
      (
        decodeControl(constructedRedirect.headers.get("x-integration-response-metadata") ?? "") as {
          status: number;
        }
      ).status,
      308,
    );
    await constructedRedirect.body?.cancel();
    const unknown = await fetch(`${base}/v1/apps/one/capabilities/sum/versions/99/invoke`, {
      method: "POST",
      headers,
    });
    assert.equal(unknown.status, 422);
    await unknown.body?.cancel();
    const protectedHeader = await fetch(`${base}/v1/apps/one/proxy/fixture/api/echo`, {
      method: "POST",
      headers: {
        ...headers,
        "x-integration-request-headers": encodeControl([["authorization", "Bearer caller"]]),
      },
      body: "bytes",
    });
    assert.equal(protectedHeader.status, 400);
    await protectedHeader.body?.cancel();
    assert.equal(providerCalls, 3);
    assert.equal((await f.db.selectFrom("credential_mutations").select("id").execute()).length, 0);
    assert.deepEqual(slackRegistration().capabilities, []);
  } finally {
    await app.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await f.close();
  }
});
