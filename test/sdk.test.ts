import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { decodeControl, encodeControl } from "../src/public/headers.js";
import { consumeEvents } from "../src/sdk/events.js";
import { ClientHttp } from "../src/sdk/http.js";
import { JobsClient } from "../src/sdk/jobs.js";
import { decodeNativeResponse, NativeClient } from "../src/sdk/native.js";
import { eventually } from "./events-runtime.js";

test("SDK uses automatic GET/HEAD raw-body carriers, generated multipart boundaries, explicit provider headers and no cookie authority", async () => {
  const seen: {
    method: string;
    control?: string;
    body: string;
    native: unknown;
    type?: string;
    token?: string;
  }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    seen.push({
      method: request.method!,
      ...(request.headers["x-integration-method"]
        ? { control: String(request.headers["x-integration-method"]) }
        : {}),
      body,
      native: decodeControl(String(request.headers["x-integration-request-headers"])),
      ...(request.headers["content-type"] ? { type: request.headers["content-type"] } : {}),
      ...(request.headers.authorization ? { token: request.headers.authorization } : {}),
    });
    response.setHeader("X-Integration-Origin", "provider");
    if (request.headers["x-integration-method"] === "HEAD")
      response.setHeader(
        "X-Integration-Response-Metadata",
        encodeControl({ version: 1, status: 200, headers: [["content-length", "1234"]] }),
      );
    response.end(request.headers["x-integration-method"] === "HEAD" ? undefined : "native body");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const http = new ClientHttp(`http://127.0.0.1:${address.port}`, "app");
  http.setBearer("memory-token");
  const native = new NativeClient(http);
  const base = { providerRegistrationId: "fixture", endpoint: "api", path: "/native" };
  try {
    await (await native.request({ ...base, method: "GET", body: "" })).text();
    const head = await native.request({ ...base, method: "HEAD", body: new Uint8Array() });
    assert.equal(head.body, null);
    assert.equal(head.headers.get("content-length"), "1234");
    await (
      await native.request({
        ...base,
        method: "POST",
        body: new Blob(["blob"], { type: "application/blob" }),
        headers: [["Content-Type", "application/native"]],
      })
    ).text();
    const form = new FormData();
    form.set("field", "value");
    await (await native.request({ ...base, method: "POST", body: form })).text();
    assert.equal(seen[0]!.method, "POST");
    assert.equal(seen[0]!.control, "GET");
    assert.equal(seen[0]!.body, "");
    assert.equal(seen[1]!.control, "HEAD");
    assert.deepEqual(seen[2]!.native, [["content-type", "application/native"]]);
    assert.match(seen[3]!.type!, /^multipart\/form-data; boundary=/);
    assert.match(seen[3]!.body, /name="field"/);
    const count = seen.length;
    await assert.rejects(
      native.request({
        ...base,
        method: "POST",
        body: form,
        headers: [["content-type", "multipart/form-data"]],
      }),
    );
    await assert.rejects(
      native.request({ ...base, method: "GET", headers: [["X-Integration-Origin", "provider"]] }),
    );
    assert.equal(seen.length, count);
    assert.ok(seen.every((request) => request.token === "Bearer memory-token"));
  } finally {
    http.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("SDK preserves route-specific 3xx provenance and one browser decoding pass; service handler errors resolve as native Responses", async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    const invoke = request.url?.includes("capabilities");
    const body = gzipSync("native redirect body");
    response.setHeader("X-Integration-Origin", "service");
    if (request.url?.includes("/capabilities/direct/")) {
      response.writeHead(422, { "content-type": "text/plain" });
      response.end("handler native failure");
      return;
    }
    response.setHeader(
      "X-Integration-Response-Metadata",
      encodeControl({
        version: 1,
        status: 307,
        headers: [
          ["location", "/native/next"],
          ["content-encoding", "gzip"],
          ["content-length", String(body.length)],
        ],
      }),
    );
    response.setHeader("Content-Encoding", "gzip");
    response.setHeader("Content-Length", body.length);
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const http = new ClientHttp(`http://127.0.0.1:${address.port}`, "app");
  http.setBearer("memory-token");
  const native = new NativeClient(http);
  native.setCapabilities(
    ["redirect", "direct"].map((id) => ({
      ref: { id, version: 1 },
      providerRegistrationId: "fixture",
      http: { input: { kind: "http" }, response: { kind: "http" } },
    })),
  );
  try {
    const redirected = await native.invoke({ capability: { id: "redirect", version: 1 } });
    assert.equal(redirected.status, 307);
    assert.equal(redirected.url, "");
    assert.equal(redirected.redirected, false);
    assert.equal(redirected.headers.get("X-Integration-Response-Metadata"), null);
    assert.equal(await redirected.text(), "native redirect body");
    const error = await native.invoke({ capability: { id: "direct", version: 1 } });
    assert.equal(error.status, 422);
    assert.equal(await error.text(), "handler native failure");
    await assert.rejects(
      native.request({
        providerRegistrationId: "fixture",
        endpoint: "api",
        method: "GET",
        path: "/spoof",
      }),
      /provenance/,
    );
    assert.equal(requests, 3);
    await assert.rejects(
      native.invoke({ capability: { id: "missing", version: 1 } }),
      /HTTP entrypoint/,
    );
    assert.equal(requests, 3);
  } finally {
    http.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("native streaming resolves at headers, propagates late failure and body cancellation, and never repeats an uncertain business request", async () => {
  let requests = 0,
    cancelled = false;
  const server = createServer((request, response) => {
    requests++;
    response.setHeader("X-Integration-Origin", "provider");
    response.flushHeaders();
    if (request.url?.endsWith("/cancel")) {
      response.write("first");
      response.once("close", () => {
        cancelled = true;
      });
      return;
    }
    response.write("partial");
    setTimeout(() => response.destroy(new Error("upstream broke")), 30);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const http = new ClientHttp(`http://127.0.0.1:${address.port}`, "app");
  http.setBearer("memory-token");
  const native = new NativeClient(http);
  const base = { providerRegistrationId: "fixture", endpoint: "api", method: "POST" as const };
  try {
    const response = await native.request({ ...base, path: "/late" });
    assert.equal(response.status, 200);
    await assert.rejects(response.text());
    const ongoing = await native.request({ ...base, path: "/cancel" });
    await ongoing.body!.cancel();
    await eventually(() => cancelled);
    assert.equal(requests, 2);
  } finally {
    http.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("malformed carrier cancels its body and HEAD carrier privilege requires an originating tunneled HEAD", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
    {
      headers: {
        "X-Integration-Origin": "provider",
        "X-Integration-Response-Metadata": encodeControl({ version: 1, status: 200, headers: [] }),
      },
    },
  );
  await assert.rejects(decodeNativeResponse(response, "proxy", "HEAD"));
  assert.equal(cancelled, true);
});

test("public SSE decoder handles split UTF-8/CRLF, bounds frames and decodes native payload once without replay cursors", async () => {
  const payload = Buffer.from(JSON.stringify({ text: "hello 🦊" })).toString("base64url");
  const data = `: heartbeat\r\n\r\nevent: provider\r\ndata: ${JSON.stringify({ version: 1, kind: "provider", id: "one", provider: "fixture", type: "native", payloadEncoding: "base64url", payloadMediaType: "application/json", payload })}\r\n\r\n`;
  const bytes = new TextEncoder().encode(data);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const seen: unknown[] = [];
  await consumeEvents(
    new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    1000,
    (event) => {
      seen.push(event);
    },
  );
  assert.deepEqual(seen, [
    {
      kind: "provider",
      id: "one",
      provider: "fixture",
      type: "native",
      data: { text: "hello 🦊" },
    },
  ]);
  await assert.rejects(
    consumeEvents(
      new Response(`event: provider\ndata: ${"x".repeat(5000)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }),
      10,
      () => {},
    ),
    /budget/,
  );
});

test("Jobs submission never replays lost admission and explicit recovery retains the caller command and opaque key", async () => {
  const seen: unknown[] = [];
  const http = new ClientHttp("http://127.0.0.1", "app", async (_url, init) => {
    seen.push(JSON.parse(String(init?.body)));
    throw new TypeError("Lost admission response");
  });
  http.setBearer("one");
  const jobs = new JobsClient(http);
  const command = jobs.submission({
    capability: { id: "fixture", version: 1 },
    input: { value: 1 },
  });
  await assert.rejects(jobs.submit(command));
  assert.equal(seen.length, 1);
  await assert.rejects(jobs.submit(command));
  assert.deepEqual(seen[0], seen[1]);
  http.close();
});
