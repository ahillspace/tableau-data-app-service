import assert from "node:assert/strict";
import { test } from "node:test";
import { ServiceClient } from "../src/sdk/client.js";
import { EventsClient } from "../src/sdk/events.js";
import { ClientHttp } from "../src/sdk/http.js";

const session = (subjectId = "alice", deploymentId = "cloud") => ({
  accessToken: "A".repeat(43),
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  authenticationExpiresAt: new Date(Date.now() + 604800000).toISOString(),
  identity: { deploymentId, siteId: "site", subjectId },
});

test("SDK restores only through credentialed identity transport and never renews/replays a native 401", async () => {
  const calls: {
    path: string;
    credentials: RequestCredentials | undefined;
    authorization: string | null;
    body: unknown;
  }[] = [];
  const client = new ServiceClient({
    serviceOrigin: "https://service.example",
    appId: "one",
    deploymentId: "cloud",
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push({
        path,
        credentials: init?.credentials,
        authorization: new Headers(init?.headers).get("authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (path.endsWith("/restore")) return Response.json(session());
      return new Response("native unauthorized", {
        status: 401,
        headers: { "X-Integration-Origin": "provider" },
      });
    },
  });
  try {
    const restored = await client.initialize();
    assert.equal(restored.identity.subjectId, "alice");
    assert.equal("accessToken" in restored, false);
    const native = await client.request({
      providerRegistrationId: "slack",
      endpoint: "api",
      method: "GET",
      path: "/native",
    });
    assert.equal(native.status, 401);
    assert.equal(await native.text(), "native unauthorized");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], {
      path: "/v1/session/restore",
      credentials: "include",
      authorization: null,
      body: { appId: "one", deploymentId: "cloud" },
    });
    assert.equal(calls[1]!.credentials, "omit");
    assert.equal(calls[1]!.authorization, `Bearer ${"A".repeat(43)}`);
  } finally {
    client.close();
  }
});

test("denied restoration clears the old memory session and prevents another ordinary dispatch", async () => {
  let denied = false,
    requests = 0;
  const client = new ServiceClient({
    serviceOrigin: "https://service.example",
    appId: "one",
    deploymentId: "cloud",
    fetch: async () => {
      requests++;
      return denied
        ? Response.json(
            { error: { code: "authentication-required", message: "Sign in" }, requestId: "test" },
            { status: 401 },
          )
        : Response.json(session());
    },
  });
  try {
    await client.restore();
    denied = true;
    await assert.rejects(client.restore(), { code: "authentication-required" });
    assert.equal(client.session(), undefined);
    await assert.rejects(client.connections(), { code: "authentication-required" });
    assert.equal(requests, 2);
  } finally {
    client.close();
  }
});

test("optional SSE reconnect does not repeat malformed UTF-8 or a failed consumer callback", async () => {
  let requests = 0;
  let malformed = true;
  const http = new ClientHttp("https://service.example", "one", async () => {
    requests++;
    return new Response(
      malformed
        ? Uint8Array.of(0xff)
        : 'event: resync-required\ndata: {"version":1,"kind":"resync-required","reason":"connected"}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  http.setBearer("memory-only");
  try {
    const events = new EventsClient(http, 1024);
    await assert.rejects(
      events.subscribe(() => {}, { reconnect: true }),
      /Invalid SSE UTF-8/,
    );
    assert.equal(requests, 1);
    malformed = false;
    await assert.rejects(
      events.subscribe(
        () => {
          throw new Error("Application stopped");
        },
        { reconnect: true },
      ),
      /Application stopped/,
    );
    assert.equal(requests, 2);
  } finally {
    http.close();
  }
});

test("restoration cannot silently switch an existing client owner, adopt another deployment, or inherit authority across client instances", async () => {
  let current = session();
  const client = new ServiceClient({
    serviceOrigin: "https://service.example",
    appId: "one",
    deploymentId: "cloud",
    fetch: async () => Response.json(current),
  });
  const other = new ServiceClient({
    serviceOrigin: "https://service.example",
    appId: "two",
    deploymentId: "cloud",
    fetch: async () => {
      throw new Error("Must not dispatch without its own bearer");
    },
  });
  try {
    await client.initialize();
    await assert.rejects(
      other.request({
        providerRegistrationId: "slack",
        endpoint: "api",
        method: "GET",
        path: "/native",
      }),
      { code: "authentication-required" },
    );
    current = session("bob");
    await assert.rejects(client.restore(), { code: "identity-changed" });
    assert.equal(client.session(), undefined);
    current = session("alice", "other");
    await assert.rejects(client.restore(), /different deployment/);
    assert.equal(client.session(), undefined);
  } finally {
    client.close();
    other.close();
  }
});
