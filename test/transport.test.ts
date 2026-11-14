import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import Fastify from "fastify";
import { sendResponse } from "../src/http/wire.js";
import { responseOrigin, TransportScope } from "../src/transport/native.js";

test("native transport preserves encoded bytes, GET bodies and redirect status; cancellation disposes unread streams with no replay", async () => {
  let requests = 0,
    closed = false;
  const server = createServer((request, response) => {
    requests++;
    if (request.url === "/api/redirect") {
      response.writeHead(307, { location: "/api/other", "x-integration-origin": "service" });
      response.end("redirect");
      return;
    }
    if (request.url === "/api/stream") {
      response.writeHead(200);
      response.write("first");
      response.on("close", () => {
        closed = true;
      });
      return;
    }
    if (request.url === "/api/echo") {
      request.pipe(response);
      return;
    }
    const bytes = gzipSync("encoded native body");
    response.writeHead(418, { "content-encoding": "gzip", "content-length": bytes.length });
    response.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No upstream port");
  const endpoint = {
    baseUrl: `http://127.0.0.1:${address.port}/api`,
    allowHttp: true,
    privateCidrs: ["127.0.0.1/32"],
  };
  const scope = new TransportScope(
    { connectTimeoutMs: 1000, headersTimeoutMs: 1000, stallTimeoutMs: 1000, maxSockets: 8 },
    new AbortController().signal,
  );
  try {
    const encoded = await scope.request(
      endpoint,
      { endpoint: "api", method: "GET", path: "/encoded" },
      new Headers({ authorization: "Bearer entrusted" }),
    );
    assert.equal(encoded.status, 418);
    assert.deepEqual(Buffer.from(await encoded.arrayBuffer()), gzipSync("encoded native body"));
    assert.equal(responseOrigin(encoded), "provider");
    const redirect = await scope.request(
      endpoint,
      { endpoint: "api", method: "GET", path: "/redirect" },
      new Headers(),
    );
    assert.equal(redirect.status, 307);
    assert.equal(redirect.headers.get("x-integration-origin"), null);
    assert.equal(await redirect.text(), "redirect");
    const echo = await scope.request(
      endpoint,
      { endpoint: "api", method: "GET", path: "/echo", body: "GET body" },
      new Headers(),
    );
    assert.equal(await echo.text(), "GET body");
    const stream = await scope.request(
      endpoint,
      { endpoint: "api", method: "GET", path: "/stream" },
      new Headers(),
    );
    const reader = stream.body?.getReader();
    assert.equal(new TextDecoder().decode((await reader?.read())?.value), "first");
    await reader?.cancel();
    await scope.dispose();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(closed, true);
    assert.equal(requests, 4);
    await assert.rejects(
      scope.request(endpoint, { endpoint: "api", method: "GET", path: "/later" }, new Headers()),
    );
  } finally {
    await scope.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("recipient policy blocks unconfigured private/metadata destinations and caller-overridden authenticators before send", async () => {
  const scope = new TransportScope(
    { connectTimeoutMs: 100, headersTimeoutMs: 100, stallTimeoutMs: 100, maxSockets: 2 },
    new AbortController().signal,
  );
  try {
    for (const host of ["127.0.0.1", "169.254.169.254"])
      await assert.rejects(
        scope.request(
          { baseUrl: `http://${host}`, allowHttp: true },
          { endpoint: "api", method: "GET", path: "/" },
          new Headers(),
        ),
        { code: "destination-denied" },
      );
    await assert.rejects(
      scope.request(
        { baseUrl: "http://127.0.0.1", allowHttp: true, privateCidrs: ["127.0.0.1/32"] },
        {
          endpoint: "api",
          method: "GET",
          path: "/",
          headers: new Headers({ "x-api-key": "caller" }),
        },
        new Headers({ "x-api-key": "entrusted" }),
      ),
      { code: "protected-header" },
    );
  } finally {
    await scope.dispose();
  }
});

test("stalled upload producers are cancelled, and pre-send header errors release the shared socket budget", async () => {
  let cancelled = false,
    calls = 0;
  const server = createServer((request, response) => {
    calls++;
    if (request.url === "/ok") response.end("ok");
    else request.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const endpoint = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    allowHttp: true,
    privateCidrs: ["127.0.0.1/32"],
  };
  const scope = new TransportScope(
    { connectTimeoutMs: 1000, headersTimeoutMs: 3000, stallTimeoutMs: 100, maxSockets: 1 },
    new AbortController().signal,
  );
  try {
    await assert.rejects(
      scope.request(
        endpoint,
        {
          endpoint: "api",
          method: "POST",
          path: "/blocked",
          headers: new Headers({ authorization: "caller" }),
        },
        new Headers({ authorization: "entrusted" }),
      ),
      { code: "protected-header" },
    );
    const good = await scope.request(
      endpoint,
      { endpoint: "api", method: "GET", path: "/ok" },
      new Headers(),
    );
    assert.equal(await good.text(), "ok");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const started = performance.now();
    await assert.rejects(
      scope.request(
        endpoint,
        { endpoint: "api", method: "POST", path: "/stall", body: stream },
        new Headers(),
      ),
      { status: 504 },
    );
    assert.ok(performance.now() - started < 2500, "upload stall must precede header timeout");
    assert.equal(cancelled, true);
    assert.equal(calls, 2, "no failed or interrupted request is replayed");
  } finally {
    await scope.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a nonreading downstream is disconnected and its producer disposed while another request progresses", async () => {
  const app = Fastify();
  let cancelled!: () => void;
  const disposed = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  app.get("/stream", async (_request, reply) => {
    await sendResponse(
      reply,
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(65536));
          },
          cancel() {
            cancelled();
          },
        }),
      ),
      "capability",
      false,
      150,
    );
    return reply;
  });
  app.get("/other", async () => "progress");
  await app.listen({ host: "127.0.0.1", port: 0 });
  const url = new URL(app.listeningOrigin);
  const socket = connect(Number(url.port), "127.0.0.1");
  socket.on("error", () => {});
  socket.pause();
  socket.write("GET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    assert.equal(await (await fetch(`${url.origin}/other`)).text(), "progress");
    await Promise.race([
      disposed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Stalled downstream retained its producer")),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    socket.destroy();
    await app.close();
  }
});
