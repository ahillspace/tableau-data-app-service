import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CloudIdentityAdapter,
  IdentityProtocol,
  ServerIdentityAdapter,
} from "../src/access/adapters.js";

test("Cloud verifies signed OIDC, nonce, access hash and UserInfo subject before accepting stable backend site/user identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tableau-identity-tls-"));
  const keyPath = join(directory, "key.pem"),
    certPath = join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const ca = await readFile(certPath, "utf8");
  const signing = generateKeyPairSync("ec", { namedCurve: "P-256" });
  let nonce = "",
    issuer = "",
    mode = "valid",
    tokenCalls = 0;
  const jwt = () => {
    const encodedHeader = Buffer.from(JSON.stringify({ alg: "ES256", kid: "fixture" })).toString(
      "base64url",
    );
    const payload = {
      iss: issuer,
      sub: "verified-subject",
      aud: "client",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      nonce: mode === "wrong-nonce" ? "wrong" : nonce,
      at_hash:
        mode === "wrong-hash"
          ? "wrong"
          : createHash("sha256")
              .update("access-token")
              .digest()
              .subarray(0, 16)
              .toString("base64url"),
    };
    const input = `${encodedHeader}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    const signature = sign("sha256", Buffer.from(input), {
      key: signing.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    return `${input}.${mode === "bad-signature" ? "A".repeat(signature.length) : signature}`;
  };
  const server = createServer({ key: await readFile(keyPath), cert: ca }, (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/token") {
      tokenCalls++;
      response.end(
        JSON.stringify({ access_token: "access-token", token_type: "Bearer", id_token: jwt() }),
      );
    } else if (request.url === "/jwks")
      response.end(
        JSON.stringify({
          keys: [
            {
              ...signing.publicKey.export({ format: "jwk" }),
              kid: "fixture",
              use: "sig",
              alg: "ES256",
            },
          ],
        }),
      );
    else if (request.url === "/userinfo")
      response.end(
        JSON.stringify({ sub: mode === "wrong-subject" ? "someone-else" : "verified-subject" }),
      );
    else if (request.url === "/api/3.24/sessions/current") {
      assert.equal(request.headers.authorization, "Bearer access-token");
      response.end(
        JSON.stringify({
          session: {
            site: { id: "stable-site" },
            user: mode === "missing-user" ? {} : { id: "stable-user" },
          },
        }),
      );
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TLS port");
  issuer = `https://127.0.0.1:${address.port}`;
  const protocol = new IdentityProtocol(
    { maxSockets: 4, connectTimeoutMs: 1000, headersTimeoutMs: 1000, stallTimeoutMs: 1000 },
    new Map([[issuer, { baseUrl: issuer, privateCidrs: ["127.0.0.1/32"], tlsCa: ca }]]),
  );
  const adapter = new CloudIdentityAdapter(
    "cloud",
    "https://service.example/callback",
    "client",
    issuer,
    protocol,
    {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`,
      jwks_uri: `${issuer}/jwks`,
      id_token_signing_alg_values_supported: ["ES256"],
    },
  );
  try {
    const started = await adapter.begin();
    nonce = started.protectedState.nonce;
    assert.equal(
      new URL(started.authorizationUrl).searchParams.get("code_challenge_method"),
      "S256",
    );
    const callback = new URLSearchParams({
      state: started.protectedState.state,
      code: "one-use-code",
    });
    const identity = await adapter.complete(
      started.protectedState,
      callback,
      new AbortController().signal,
    );
    assert.equal(identity.subjectId, "stable-user");
    assert.equal(identity.siteId, "stable-site");
    assert.equal(identity.deploymentId, "cloud");
    for (mode of ["wrong-nonce", "wrong-hash", "bad-signature", "wrong-subject", "missing-user"])
      await assert.rejects(
        adapter.complete(started.protectedState, callback, new AbortController().signal),
        { code: "identity-verification-failed" },
      );
    const before = tokenCalls;
    await assert.rejects(
      adapter.complete(
        started.protectedState,
        new URLSearchParams({ state: "wrong", code: "code" }),
        new AbortController().signal,
      ),
    );
    assert.equal(tokenCalls, before);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("Server uses its distinct reference endpoint/callback/client contract and rejects Cloud endpoints or MCP impersonation", async () => {
  const protocol = new IdentityProtocol(
    { maxSockets: 2, connectTimeoutMs: 1000, headersTimeoutMs: 1000, stallTimeoutMs: 1000 },
    new Map(),
  );
  const adapter = new ServerIdentityAdapter(
    "server",
    "https://service.example/Callback",
    "https://tableau.example",
    "content-url",
    "site-id",
    "3.29",
    "registered-integration-service",
    protocol,
  );
  const start = await adapter.begin();
  const url = new URL(start.authorizationUrl);
  assert.equal(url.pathname, "/oauth2/v1/auth");
  assert.equal(url.searchParams.get("client_type"), "registered-integration-service");
  assert.equal(url.searchParams.get("target_site"), "content-url");
  assert.throws(
    () =>
      new ServerIdentityAdapter(
        "server",
        "https://service.example/callback",
        "https://tableau.example",
        "content-url",
        "site-id",
        "3.29",
        "registered-integration-service",
        protocol,
      ),
  );
  assert.throws(
    () =>
      new ServerIdentityAdapter(
        "server",
        "https://service.example/Callback",
        "https://tableau.example",
        "content-url",
        "site-id",
        "3.29",
        "tableau-mcp",
        protocol,
      ),
  );
});

test("Server exchanges PKCE over verified TLS and rejects wrong origin, site, identity and callback state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tableau-server-tls-"));
  const keyPath = join(directory, "key.pem"),
    certPath = join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const ca = await readFile(certPath, "utf8");
  let mode = "valid",
    origin = "",
    verifier = "",
    calls = 0;
  const server = createServer(
    { key: await readFile(keyPath), cert: ca },
    async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/oauth2/v1/token") {
        calls++;
        const chunks = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = new URLSearchParams(Buffer.concat(chunks).toString());
        assert.equal(body.get("code_verifier"), verifier);
        assert.equal(body.get("redirect_uri"), "https://service.example/Callback");
        response.end(
          JSON.stringify({
            access_token: "server-session",
            origin_host: mode === "wrong-origin" ? "https://attacker.example" : origin,
          }),
        );
      } else if (request.url === "/api/3.29/sessions/current") {
        assert.equal(request.headers["x-tableau-auth"], "server-session");
        response.end(
          JSON.stringify({
            session: {
              site: { id: mode === "wrong-site" ? "other-site" : "site-id" },
              user: mode === "missing-user" ? {} : { id: "server-user" },
            },
          }),
        );
      } else response.writeHead(404).end("{}");
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TLS port");
  origin = `https://127.0.0.1:${address.port}`;
  const adapter = new ServerIdentityAdapter(
    "server",
    "https://service.example/Callback",
    origin,
    "content-url",
    "site-id",
    "3.29",
    "registered-integration-service",
    new IdentityProtocol(
      { maxSockets: 2, connectTimeoutMs: 1000, headersTimeoutMs: 1000, stallTimeoutMs: 1000 },
      new Map([[origin, { baseUrl: origin, privateCidrs: ["127.0.0.1/32"], tlsCa: ca }]]),
    ),
  );
  try {
    const start = await adapter.begin();
    verifier = start.protectedState.verifier;
    const callback = new URLSearchParams({
      code: "one-use-code",
      state: start.protectedState.state,
    });
    const result = await adapter.complete(
      start.protectedState,
      callback,
      new AbortController().signal,
    );
    assert.equal(result.subjectId, "server-user");
    assert.equal(result.siteId, "site-id");
    for (mode of ["wrong-origin", "wrong-site", "missing-user"])
      await assert.rejects(
        adapter.complete(start.protectedState, callback, new AbortController().signal),
        { code: "identity-verification-failed" },
      );
    const before = calls;
    await assert.rejects(
      adapter.complete(
        start.protectedState,
        new URLSearchParams({ code: "code", state: "wrong" }),
        new AbortController().signal,
      ),
    );
    assert.equal(calls, before, "invalid callback must not reach token exchange");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
