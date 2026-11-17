import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildConsole } from "../scripts/build-console.ts";
import { AdminApi } from "../src/console/dom.ts";
import {
  defaultAuthentication,
  definitionChanges,
  editableDefinition,
  newDefinition,
  serializeSecret,
} from "../src/console/model.ts";
import type { DefinitionView } from "../src/contracts/operator.ts";

test("console secret writes preserve exact multiline input and require explicit clearing", () => {
  const pem = "-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----\n";
  assert.deepEqual(serializeSecret({ destination: "signingPrivateKey", multiline: pem }), {
    secrets: { signingPrivateKey: pem },
  });
  const json = '{\n  "private_key": "synthetic"\n}\n';
  assert.deepEqual(
    serializeSecret({ destination: "credential", kind: "import", multiline: json }),
    { credential: { kind: "import", value: json } },
  );
  assert.throws(
    () => serializeSecret({ destination: "clientSecret", value: "" }),
    /Blank never clears/,
  );
  assert.deepEqual(serializeSecret({ destination: "clientSecret", clear: true }), {
    secrets: { clientSecret: null },
  });
  assert.deepEqual(serializeSecret({ destination: "credential", clear: true }), {
    credential: null,
  });
  assert.throws(
    () => serializeSecret({ destination: "clientSecret", clear: true, value: "synthetic" }),
    /either/,
  );
  assert.throws(
    () => serializeSecret({ destination: "clientSecret", value: "one", multiline: "two" }),
    /one value/,
  );
});

test("connection keys and Basic credentials never become application secrets", () => {
  assert.deepEqual(
    serializeSecret({
      destination: "credential",
      kind: "jwt",
      multiline: "key\n",
      issuer: "synthetic-issuer",
    }),
    { credential: { kind: "jwt", privateKey: "key\n", issuer: "synthetic-issuer" } },
  );
  assert.deepEqual(
    serializeSecret({
      destination: "credential",
      kind: "basic",
      username: "user",
      password: " pass ",
    }),
    { credential: { kind: "basic", username: "user", password: " pass " } },
  );
});

test("public drafts copy catalog data and exclude all read metadata and credentials", () => {
  const template = newDefinition();
  template.apiHosts = ["https://example.test"];
  const draft = newDefinition(template);
  draft.apiHosts.push("https://other.test");
  assert.equal(template.apiHosts.length, 1);
  const view: DefinitionView = {
    ...template,
    retired: false,
    generation: 1,
    version: 3,
    secrets: {
      clientSecret: { set: true, setAt: null },
      signingPrivateKey: { set: false, setAt: null },
      signingSecret: { set: false, setAt: null },
    },
    credential: { set: true, setAt: null },
    setup: { state: "ready", missing: [], actions: [] },
    connectionCounts: { connected: 1, needsAuthorization: 0, disconnected: 0 },
  };
  assert.deepEqual(editableDefinition(view), template);
  assert.equal(Object.hasOwn(editableDefinition(view), "secrets"), false);
});

test("ordinary edits retain generation while every destination or interpretation edit redefines", () => {
  const before = newDefinition();
  before.id = "test";
  before.reauthorizationInterval = 60;
  const after = structuredClone(before);
  after.displayName = "Changed";
  delete after.reauthorizationInterval;
  assert.deepEqual(definitionChanges(before, after), {
    redefine: false,
    patch: { displayName: "Changed", reauthorizationInterval: null },
  });
  for (const change of [
    { apiHosts: ["https://example.test"] },
    { privateHosts: true },
    { ownership: "personal" as const },
    { authentication: defaultAuthentication("static") },
    { credentialPlacement: { kind: "query" as const, name: "key" } },
  ]) {
    assert.equal(definitionChanges(before, { ...before, ...change }).redefine, true);
  }
});

test("operator transport sends same-origin cookies and CSRF, never retries a mutation", async () => {
  const saved = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = (async (_url, init) => {
    calls.push(init!);
    return Response.json(
      {
        error: {
          code: "definition-conflict",
          message: "Definition changed",
          fields: [{ path: "expectedVersion", rule: "current-version" }],
        },
      },
      { status: 409 },
    );
  }) as typeof fetch;
  try {
    const api = new AdminApi();
    api.csrf = "synthetic-csrf";
    await assert.rejects(
      api.request("PUT", "/v1/admin/definitions/test/secrets", {
        expectedVersion: 1,
        secrets: { clientSecret: "synthetic" },
      }),
      { code: "definition-conflict" },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.credentials, "same-origin");
    assert.equal(new Headers(calls[0]!.headers).get("X-TDAS-CSRF"), "synthetic-csrf");
    assert.equal(new Headers(calls[0]!.headers).has("Tableau-Service-Authorization"), false);
  } finally {
    globalThis.fetch = saved;
  }
});

test("denied operator access clears transport state and rejects an older in-flight read", async () => {
  const saved = globalThis.fetch;
  let release!: (response: Response) => void;
  globalThis.fetch = ((path: string) =>
    path.endsWith("definitions")
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : Promise.resolve(
          Response.json(
            { error: { code: "operator-required", message: "Operator access required" } },
            { status: 403 },
          ),
        )) as typeof fetch;
  try {
    const api = new AdminApi();
    api.csrf = "synthetic";
    let denied = 0;
    api.onDenied = () => {
      denied++;
      api.clear();
    };
    const pending = api.request("GET", "/v1/admin/definitions");
    await assert.rejects(api.request("GET", "/v1/admin/session"), { code: "operator-required" });
    release(Response.json({ definitions: [{ id: "must-not-render" }] }));
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(denied, 1);
    assert.equal(api.csrf, "");
  } finally {
    globalThis.fetch = saved;
  }
});

test("console builds only local production assets without inline scripts or persistent bearers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tdas-console-"));
  try {
    const result = await buildConsole(directory);
    assert.deepEqual(result.files, ["index.html", "index.js", "index.css"]);
    const html = await readFile(join(directory, "index.html"), "utf8");
    const js = await readFile(join(directory, "index.js"), "utf8");
    const css = await readFile(join(directory, "index.css"), "utf8");
    assert.match(html, /src="\/console\/assets\/index.js"/);
    assert.match(html, /href="\/console\/assets\/index.css"/);
    assert.doesNotMatch(html, /<style|\son\w+=|<script(?![^>]*src=)/);
    assert.doesNotMatch(js, /\b(?:localStorage|sessionStorage)\b|https:\/\/cdn\./);
    assert.match(css, /prefers-reduced-transparency/);
    assert.match(css, /prefers-reduced-motion/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
