import assert from "node:assert/strict";
import { createServer } from "node:net";
import { after, before, describe, test } from "node:test";
import { ServiceError } from "../src/platform/errors.ts";
import { classifyAddress, Outbound, type Resolver } from "../src/platform/outbound.ts";
import { loopback, type StandIn, standIn, testCa } from "./support/https.ts";

const timeouts = { connectTimeoutMs: 2000, headersTimeoutMs: 2000, idleTimeoutMs: 2000 };

async function drain(body: NodeJS.ReadableStream): Promise<string> {
  let out = "";
  for await (const chunk of body) out += chunk.toString();
  return out;
}

async function refusal(promise: Promise<unknown>): Promise<ServiceError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ServiceError, `expected ServiceError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected a refusal");
}

describe("outbound HTTPS", () => {
  let server: StandIn;
  let hits = 0;
  before(async () => {
    server = await standIn((req, res) => {
      hits++;
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "https://elsewhere.example/" });
        res.end();
      } else if (req.url === "/big-headers") {
        res.writeHead(200, { "x-big": "a".repeat(512 * 1024) });
        res.end("ok");
      } else if (req.url === "/drop") {
        req.socket.destroy();
      } else if (req.url === "/slow") {
        setTimeout(() => res.end("late"), 1500).unref();
      } else {
        res.writeHead(200, { connection: "close", "x-seen-host": String(req.headers.host) });
        res.end("ok");
      }
    });
  });
  after(() => server.close());

  test("classifies addresses", () => {
    assert.equal(classifyAddress("8.8.8.8"), "allowed");
    assert.equal(classifyAddress("127.0.0.1"), "private");
    assert.equal(classifyAddress("10.1.2.3"), "private");
    assert.equal(classifyAddress("fd12::1"), "private");
    assert.equal(classifyAddress("fe80::1"), "private");
    assert.equal(classifyAddress("224.0.0.1"), "private");
    assert.equal(classifyAddress("::ffff:127.0.0.1"), "private");
    assert.equal(classifyAddress("169.254.169.254"), "metadata");
    assert.equal(classifyAddress("::ffff:169.254.169.254"), "metadata");
    assert.equal(classifyAddress("fd00:ec2::254"), "metadata");
  });

  test("V18 refuses loopback without privateHosts at socket time", async () => {
    const outbound = new Outbound({ ...timeouts, extraCa: [testCa()], resolver: loopback });
    try {
      const error = await refusal(
        outbound.request(new URL(`${server.origin}/`), {
          method: "GET",
          headers: [],
          privateHosts: false,
        }),
      );
      assert.equal(error.code, "destination-refused");
      assert.equal(error.upstream, "not-sent");
      assert.match(error.message, /localhost/);
      assert.doesNotMatch(error.message, /127\.0\.0\.1/);
    } finally {
      await outbound.close();
    }
  });

  test("V18 refuses metadata addresses even with privateHosts, including after a DNS change", async () => {
    let answer = "127.0.0.1";
    const resolver: Resolver = async () => [{ address: answer, family: 4 }];
    const outbound = new Outbound({ ...timeouts, extraCa: [testCa()], resolver });
    try {
      const first = await outbound.request(new URL(`${server.origin}/`), {
        method: "GET",
        headers: [],
        privateHosts: true,
      });
      assert.equal(first.status, 200);
      assert.equal(await drain(first.body), "ok");
      answer = "169.254.169.254";
      const error = await refusal(
        outbound.request(new URL(`${server.origin}/`), {
          method: "GET",
          headers: [],
          privateHosts: true,
        }),
      );
      assert.equal(error.code, "destination-refused");
      const literal = await refusal(
        outbound.request(new URL("https://169.254.169.254/latest"), {
          method: "GET",
          headers: [],
          privateHosts: true,
        }),
      );
      assert.equal(literal.code, "destination-refused");
    } finally {
      await outbound.close();
    }
  });

  test("V18 refuses plain HTTP", async () => {
    const outbound = new Outbound(timeouts);
    try {
      const error = await refusal(
        outbound.request(new URL("http://example.com/"), {
          method: "GET",
          headers: [],
          privateHosts: false,
        }),
      );
      assert.equal(error.code, "destination-refused");
    } finally {
      await outbound.close();
    }
  });

  test("TLS is verified against trust anchors and hostnames", async () => {
    const untrusted = new Outbound({ ...timeouts, resolver: loopback });
    const mismatched = new Outbound({
      ...timeouts,
      extraCa: [testCa()],
      resolver: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    try {
      const a = await refusal(
        untrusted.request(new URL(`${server.origin}/`), {
          method: "GET",
          headers: [],
          privateHosts: true,
        }),
      );
      assert.equal(a.code, "upstream-tls-failed");
      const b = await refusal(
        mismatched.request(new URL(`https://wrong-name.test:${server.port}/`), {
          method: "GET",
          headers: [],
          privateHosts: true,
        }),
      );
      assert.equal(b.code, "upstream-tls-failed");
    } finally {
      await untrusted.close();
      await mismatched.close();
    }
  });

  test("redirects are returned, not followed", async () => {
    const outbound = new Outbound({ ...timeouts, extraCa: [testCa()], resolver: loopback });
    try {
      const response = await outbound.request(new URL(`${server.origin}/redirect`), {
        method: "GET",
        headers: [],
        privateHosts: true,
      });
      assert.equal(response.status, 302);
      assert.deepEqual(
        response.headers.find(([name]) => name === "location"),
        ["location", "https://elsewhere.example/"],
      );
      await drain(response.body);
    } finally {
      await outbound.close();
    }
  });

  test("sets no limit of its own on the size of a provider's response headers", async () => {
    const outbound = new Outbound({ ...timeouts, extraCa: [testCa()], resolver: loopback });
    try {
      const response = await outbound.request(new URL(`${server.origin}/big-headers`), {
        method: "GET",
        headers: [],
        privateHosts: true,
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.find(([name]) => name === "x-big")?.[1].length, 512 * 1024);
      await drain(response.body);
    } finally {
      await outbound.close();
    }
  });

  test("V19 never retries and says whether the provider may have received the request", async () => {
    const outbound = new Outbound({
      ...timeouts,
      headersTimeoutMs: 300,
      extraCa: [testCa()],
      resolver: loopback,
    });
    try {
      hits = 0;
      for (const method of ["GET", "POST", "PUT"]) {
        const error = await refusal(
          outbound.request(new URL(`${server.origin}/drop`), {
            method,
            headers: [],
            privateHosts: true,
          }),
        );
        assert.equal(error.code, "upstream-interrupted");
        assert.equal(error.upstream, "may-have-been-sent");
      }
      assert.equal(hits, 3);

      hits = 0;
      const slow = await refusal(
        outbound.request(new URL(`${server.origin}/slow`), {
          method: "GET",
          headers: [],
          privateHosts: true,
        }),
      );
      assert.equal(slow.code, "upstream-timeout");
      assert.equal(slow.upstream, "may-have-been-sent");
      assert.equal(hits, 1);

      const closed = await new Promise<number>((resolve) => {
        const probe = createServer();
        probe.listen(0, "127.0.0.1", () => {
          const port = (probe.address() as { port: number }).port;
          probe.close(() => resolve(port));
        });
      });
      const unreachable = await refusal(
        outbound.request(new URL(`https://localhost:${closed}/`), {
          method: "GET",
          headers: [],
          privateHosts: true,
        }),
      );
      assert.equal(unreachable.code, "upstream-unreachable");
      assert.equal(unreachable.upstream, "not-sent");
    } finally {
      await outbound.close();
    }
  });
});
