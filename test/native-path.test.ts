import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { test } from "node:test";
import { ConnectionService } from "../src/connections/service.js";
import { createHttpApp } from "../src/http/app.js";
import { registerCoreRoutes } from "../src/http/core-routes.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { candidate, coreFixture, fixtureProvider } from "./core-fixture.js";

// http.request preserves the exact target, including traversal that Fetch normalizes.
function send(origin: string, path: string, token: string, connection: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(
      origin,
      {
        method: "DELETE",
        path,
        headers: { authorization: `Bearer ${token}`, "x-integration-connection": connection },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }),
        );
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

test("native HTTP routing preserves encoded object identity and query while rejecting encoded separators, traversal and custody bypass", async () => {
  const f = await coreFixture();
  const targets: string[] = [];
  const upstream = createServer((request, response) => {
    assert.equal(request.method, "DELETE");
    assert.equal(request.headers.authorization, "Bearer secret-one");
    targets.push(request.url!);
    response.end(request.url);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing upstream port");
  const provider = {
    ...fixtureProvider,
    endpoints: {
      api: {
        baseUrl: `http://127.0.0.1:${address.port}/api`,
        allowHttp: true,
        privateCidrs: ["127.0.0.1/32"],
        blockedPaths: ["/api/entrusted"],
      },
    },
  };
  const providers = new ProviderRegistry([provider]);
  const connections = new ConnectionService(f.db, f.access, f.secrets, providers, {
    connectTimeoutMs: 1000,
    headersTimeoutMs: 1000,
    stallTimeoutMs: 1000,
    maxSockets: 8,
  });
  const app = await createHttpApp({ db: f.db });
  registerCoreRoutes(app, {
    access: f.access,
    credentials: f.credentials,
    connections,
    providers,
    corsOrigins: [],
    jsonPreparationBytes: 1024,
  });
  try {
    const connection = await f.credentials.publishLocal(f.alice.access, provider, candidate());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const suffixes = ["a%3Fb", "a%3fb", "a%23b", "a%25b", "a%20b", "a%252Fb"];
    const observed = [];
    for (const suffix of suffixes) {
      const result = await send(
        app.listeningOrigin,
        `/v1/apps/one/proxy/fixture/api/objects/${suffix}?selection=keep%2Fvalue`,
        f.alice.token,
        connection.id,
      );
      observed.push(result);
    }
    assert.deepEqual(
      observed,
      suffixes.map((suffix) => ({
        status: 200,
        body: `/api/objects/${suffix}?selection=keep%2Fvalue`,
      })),
    );
    assert.deepEqual(
      targets,
      suffixes.map((suffix) => `/api/objects/${suffix}?selection=keep%2Fvalue`),
    );
    for (const suffix of [
      "objects/a%2Fb",
      "objects/a%2fb",
      "objects/a%5Cb",
      "objects/a%2Eb",
      "objects/../secret",
      "objects/./secret",
      "objects/%2e%2e/secret",
    ]) {
      const result = await send(
        app.listeningOrigin,
        `/v1/apps/one/proxy/fixture/api/${suffix}`,
        f.alice.token,
        connection.id,
      );
      assert.equal(result.status, 400, suffix);
    }
    for (const suffix of ["entrusted", "%65ntrusted", "entrusted/child"]) {
      const result = await send(
        app.listeningOrigin,
        `/v1/apps/one/proxy/fixture/api/${suffix}`,
        f.alice.token,
        connection.id,
      );
      assert.equal(result.status, 403, suffix);
    }
    assert.equal(targets.length, suffixes.length, "rejected paths cannot cause a provider send");
  } finally {
    await app.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await f.close();
  }
});
