import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { after, before, beforeEach, describe, test } from "node:test";
import { listSites } from "../src/identity/directory.ts";
import type { Principal, SignInSession } from "../src/identity/types.ts";
import type { Db } from "../src/persistence/database.ts";
import { ServiceError } from "../src/platform/errors.ts";
import { Log } from "../src/platform/log.ts";
import { destination, forwardableRequestHeaders, NativeRouter } from "../src/router/router.ts";
import { type ConnectionsHarness, connectionsHarness } from "./support/connections.ts";
import { freshDatabase, testKeys } from "./support/db.ts";
import { standIn } from "./support/https.ts";
import {
  appSignIn,
  type IdentityHarness,
  identityHarness,
  operatorSignIn,
  tableauSignIn,
} from "./support/identity.ts";
import { OAuthStandIn } from "./support/oauth.ts";
import { TableauStandIn, type TableauUser } from "./support/tableau.ts";

const alice: TableauUser = {
  siteId: "site-a",
  siteContentUrl: "alpha",
  userId: "user-a",
  userName: "alice@example.com",
};
const operatorUser: TableauUser = {
  siteId: "site-a",
  siteContentUrl: "alpha",
  userId: "user-op",
  userName: "op@example.com",
};

async function text(body: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function base(apiHosts: string[]) {
  return {
    id: "d",
    displayName: "D",
    authentication: { method: "static" as const },
    ownership: "shared" as const,
    apiHosts,
    scopes: [],
    credentialPlacement: { kind: "bearer" as const },
    audience: [],
    privateHosts: false,
    enabled: true,
    retired: false,
    generation: 1,
    version: 1,
    secretGeneration: 1,
  };
}

describe("router", () => {
  test("the service's own headers and cookies never reach the provider; everything else does", () => {
    assert.deepEqual(
      forwardableRequestHeaders([
        ["Tableau-Service-Authorization", "Bearer secret"],
        ["Cookie", "__Host-tdas-restore=r; app=1; __Host-tdas-sign-in=s; theme=dark"],
        ["Authorization", "Basic app"],
        ["Connection", "keep-alive, x-hop"],
        ["X-Hop", "1"],
        ["X-App", "kept"],
      ]),
      [
        ["Cookie", "app=1; theme=dark"],
        ["Authorization", "Basic app"],
        ["X-App", "kept"],
      ],
    );
    assert.deepEqual(forwardableRequestHeaders([["cookie", "__Host-tdas-restore=r"]]), []);
  });

  test("the path is kept byte for byte and must stay under the base path", () => {
    const d = base(["https://api.example/v2", "https://files.example"]);
    assert.equal(
      destination(d, "/items/a%2Fb?x=%20y&x=2", undefined).target,
      "/v2/items/a%2Fb?x=%20y&x=2",
    );
    assert.equal(destination(d, "", undefined).target, "/v2");
    assert.equal(destination(d, "?q=1", undefined).target, "/v2?q=1");
    assert.equal(destination(d, "/upload", "https://files.example").url.host, "files.example");
    const rule = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        assert.ok(error instanceof ServiceError);
        return error.fields?.[0]?.rule;
      }
      return "accepted";
    };
    assert.equal(
      rule(() => destination(d, "/../admin", undefined)),
      "under-api-host",
    );
    assert.equal(
      rule(() => destination(d, "/%2e%2e/admin", undefined)),
      "under-api-host",
    );
    assert.equal(
      rule(() => destination(d, "@evil.example/x", undefined)),
      "under-api-host",
    );
    assert.equal(
      rule(() => destination(d, "/x", "https://evil.example")),
      "matching-api-host",
    );
    // Encoded slashes stay encoded and stay under the base path.
    assert.equal(
      rule(() => destination(d, "/..%2fadmin", undefined)),
      "accepted",
    );
  });

  describe("forwarding", () => {
    let tableau: TableauStandIn;
    let provider: OAuthStandIn;
    let db: Db;
    let closeDb: (() => Promise<void>) | undefined;
    let h: IdentityHarness;
    let c: ConnectionsHarness;
    let router: NativeRouter;
    let principal: Principal;
    let shareStatic: (id: string, apiHost: string, value: string) => Promise<void>;

    before(async () => {
      tableau = await new TableauStandIn().start();
      provider = await new OAuthStandIn().start();
    });
    after(async () => {
      await h.close();
      await closeDb?.();
      await provider.close();
      await tableau.close();
    });
    beforeEach(async () => {
      provider.reset();
      if (closeDb) {
        await h.close();
        await closeDb();
      }
      ({ db, close: closeDb } = await freshDatabase());
      h = await identityHarness(db, tableau);
      c = connectionsHarness(db, { keys: testKeys(), outbound: h.outbound, clock: h.clock });
      router = new NativeRouter({
        connections: c.connections,
        outbound: h.outbound,
        log: new Log(() => {}),
      });
      const op = await tableauSignIn(h, tableau, operatorUser);
      const opSession = (await h.identity.readSignInSession(op.cookie)) as SignInSession;
      const opPrincipal = (await operatorSignIn(h, op.cookie)).principal;
      const siteId = ((await listSites(db))[0] as { id: string }).id;
      shareStatic = async (id, apiHost, value) => {
        await c.definitions.create("test", {
          id,
          displayName: id,
          authentication: { method: "static" as const },
          ownership: "shared",
          apiHosts: [apiHost],
          credentialPlacement: { kind: "header", name: "X-Api-Key" },
          audience: [siteId],
          privateHosts: true,
          credential: { kind: "token", value },
        });
      };
      await shareStatic("files", `${provider.origin}/api`, "key-1");
      const a = await tableauSignIn(h, tableau, alice);
      principal = (await appSignIn(h, a.cookie)).principal;
    });

    test("V16 requests and responses pass through apart from the documented headers", async () => {
      provider.apiHandler = (_req, res) => {
        res.writeHead(418, [
          "Content-Type",
          "application/x-odd",
          "Cache-Control",
          "private, max-age=5",
          "X-Custom",
          "one",
          "X-Custom",
          "two",
          "Keep-Alive",
          "timeout=5",
          "Access-Control-Allow-Origin",
          "https://provider.example",
        ]);
        res.end("teapot body");
      };
      const response = await router.forward({
        principal,
        definitionId: "files",
        method: "PROPFIND",
        target: "/a%2Fb/c?z=1&z=2",
        headers: [
          ["Tableau-Service-Authorization", "Bearer service-secret"],
          ["Authorization", "Basic app-own"],
          ["X-Api-Key", "app-sent"],
          ["Content-Type", "text/odd"],
          ["Connection", "x-hop"],
          ["X-Hop", "drop me"],
          ["Proxy-Authorization", "drop"],
          ["X-Keep", "keep"],
        ],
        body: Readable.from([Buffer.from("request body")]),
        signal: new AbortController().signal,
      });
      assert.equal(response.status, 418);
      assert.equal(await text(response.body), "teapot body");
      const names = response.headers.map(([n]) => n.toLowerCase());
      assert.ok(names.includes("cache-control"));
      assert.equal(response.headers.filter(([n]) => n === "x-custom").length, 2);
      assert.ok(!names.includes("keep-alive"));
      assert.ok(!names.includes("access-control-allow-origin"));
      const seen = provider.apiRequests[0];
      assert.ok(seen);
      assert.equal(seen.method, "PROPFIND");
      assert.equal(seen.url, "/api/a%2Fb/c?z=1&z=2");
      assert.equal(seen.headers.authorization, "Basic app-own");
      assert.equal(seen.headers["x-api-key"], "key-1");
      assert.equal(seen.headers["content-type"], "text/odd");
      assert.equal(seen.headers["x-keep"], "keep");
      assert.equal(seen.headers["x-hop"], undefined);
      assert.equal(seen.headers["proxy-authorization"], undefined);
      assert.equal(seen.headers["tableau-service-authorization"], undefined);
      assert.equal(seen.headers.host, new URL(provider.origin).host);
      assert.equal(seen.body.toString(), "request body");
    });

    test("V17 large uploads and downloads stream through without being buffered", async () => {
      // Streaming is measured as bytes in flight, not as process memory: the most bytes one side has
      // produced that the other has not yet consumed. A router that buffers a body holds all of it,
      // so its in-flight count reaches the full size; a streaming router holds only what transport
      // buffers (socket, TLS and stream high-water marks) allow. The count does not depend on garbage
      // collection timing or on how much memory the test process happens to retain.
      const MB = 1024 * 1024;
      const size = 96 * MB;
      const bound = 24 * MB;
      let yielded = 0;
      let received = 0;
      let sent = 0;
      let downloaded = 0;
      let uploadInFlight = 0;
      let downloadInFlight = 0;
      const stream = await standIn((req, res) => {
        req.on("data", (chunk: Buffer) => {
          received += chunk.length;
        });
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/octet-stream" });
          const chunk = Buffer.alloc(MB, 7);
          const pump = () => {
            while (sent < size) {
              sent += chunk.length;
              downloadInFlight = Math.max(downloadInFlight, sent - downloaded);
              if (!res.write(chunk)) return void res.once("drain", pump);
            }
            res.end();
          };
          pump();
        });
      });
      try {
        await shareStatic("blobs", `${stream.origin}/api`, "key-2");
        const upload = (async function* () {
          const chunk = Buffer.alloc(MB, 3);
          while (yielded < size) {
            yielded += chunk.length;
            uploadInFlight = Math.max(uploadInFlight, yielded - received);
            yield chunk;
          }
        })();
        const response = await router.forward({
          principal,
          definitionId: "blobs",
          method: "PUT",
          target: "/blob",
          headers: [["content-type", "application/octet-stream"]],
          body: Readable.from(upload),
          signal: new AbortController().signal,
        });
        for await (const chunk of response.body) downloaded += (chunk as Buffer).length;
        assert.equal(received, size);
        assert.equal(downloaded, size);
        const inFlight = `upload ${Math.round(uploadInFlight / MB)} MB, download ${Math.round(downloadInFlight / MB)} MB in flight while moving ${size / MB} MB each way`;
        assert.ok(uploadInFlight < bound && downloadInFlight < bound, inFlight);
      } finally {
        await stream.close();
      }
    });

    test("redirects come back to the app and checkout failures send nothing", async () => {
      provider.apiHandler = (_req, res) => {
        res.writeHead(302, { location: "https://elsewhere.example/x" });
        res.end();
      };
      const response = await router.forward({
        principal,
        definitionId: "files",
        method: "GET",
        target: "/r",
        headers: [],
        body: null,
        signal: new AbortController().signal,
      });
      assert.equal(response.status, 302);
      assert.equal(
        response.headers.find(([n]) => n === "location")?.[1],
        "https://elsewhere.example/x",
      );
      await text(response.body);
      const before = provider.apiRequests.length;
      await assert.rejects(
        router.forward({
          principal,
          definitionId: "missing",
          method: "GET",
          target: "/",
          headers: [],
          body: null,
          signal: new AbortController().signal,
        }),
        (e: ServiceError) => e.code === "definition-not-found" && e.upstream === "not-sent",
      );
      assert.equal(provider.apiRequests.length, before);
    });
  });
});
