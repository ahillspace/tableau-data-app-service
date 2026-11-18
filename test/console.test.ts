import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildConsole } from "../scripts/build-console.ts";
import { AdminApi } from "../src/console/dom.ts";
import { Status } from "../src/console/status.ts";
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

test("audit pagination keeps applied filters until explicit reset and ignores cleared responses", async () => {
  const nodes = new Map<string, AuditNode>();
  class AuditNode {
    value = "";
    disabled = false;
    onclick: ((event: { target: AuditNode }) => void) | null = null;
    onkeydown: ((event: { key: string }) => void) | null = null;
    #html = "";
    readonly #attributes: string;
    constructor(attributes = "") {
      this.#attributes = attributes;
    }
    get innerHTML(): string {
      return this.#html;
    }
    set innerHTML(html: string) {
      this.#html = html;
      for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g))
        nodes.set(match[1]!, new AuditNode(match[0]));
    }
    closest(): AuditNode {
      return this;
    }
    hasAttribute(name: string): boolean {
      return this.#attributes.includes(name);
    }
    replaceChildren(): void {
      this.#html = "";
      nodes.clear();
      nodes.set("status", this);
    }
  }
  const node = (id: string): AuditNode => {
    const result = nodes.get(id);
    assert.ok(result, `mounted control ${id}`);
    return result;
  };
  nodes.set("status", new AuditNode());
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const savedFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { getElementById: (id: string) => nodes.get(id) ?? null },
  });
  const requests: URLSearchParams[] = [];
  const responses: ((response: Response) => void)[] = [];
  globalThis.fetch = (async (url) => {
    const parsed = new URL(String(url), "https://service.test");
    if (parsed.pathname !== "/v1/admin/audit") return Response.json({}, { status: 503 });
    requests.push(parsed.searchParams);
    return new Promise<Response>((resolve) => responses.push(resolve));
  }) as typeof fetch;
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const page = (prefix: string, count: number) => ({
    entries: Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${index}`,
      at: "2026-11-17T07:40:00Z",
      action: prefix,
      actor: "operator",
      subject: "definition",
      details: {},
    })),
  });
  const answer = async (prefix: string, count = 100) => {
    const resolve = responses.shift();
    assert.ok(resolve, "an audit request is pending");
    resolve(Response.json(page(prefix, count)));
    await settle();
  };
  const click = (attribute: string) =>
    node("status").onclick!({ target: new AuditNode(attribute) });
  try {
    const status = new Status(new AdminApi());
    status.mount();
    node("range").value = "1";
    node("auditAction").value = "first";
    node("auditDefinition").value = "provider-one";
    const initial = status.load();
    await answer("first");
    await initial;
    node("auditAction").value = "draft";
    node("auditDefinition").value = "provider-two";
    click("data-more-audit");
    assert.equal(requests.at(-1)!.get("action"), "first");
    assert.equal(requests.at(-1)!.get("definition"), "provider-one");
    assert.equal(requests.at(-1)!.get("before"), "first-99");
    await answer("older", 1);
    assert.ok(node("auditContent").innerHTML.includes("<td>first</td>"));
    assert.ok(node("auditContent").innerHTML.includes("older"));
    node("filterAudit").onclick!({ target: node("filterAudit") });
    assert.equal(requests.at(-1)!.get("action"), "draft");
    assert.equal(requests.at(-1)!.get("definition"), "provider-two");
    assert.equal(requests.at(-1)!.has("before"), false);
    assert.equal(node("auditContent").innerHTML.includes("older"), false);
    await answer("applied");
    node("auditAction").value = "enter";
    node("auditAction").onkeydown!({ key: "Enter" });
    assert.equal(requests.at(-1)!.get("action"), "enter");
    assert.equal(requests.at(-1)!.has("before"), false);
    const fail = responses.shift();
    assert.ok(fail);
    fail(Response.json({}, { status: 503 }));
    await settle();
    assert.ok(node("auditContent").innerHTML.includes("Retry audit"));
    node("auditAction").value = "retry";
    click("data-retry-audit");
    assert.equal(requests.at(-1)!.get("action"), "retry");
    assert.equal(requests.at(-1)!.has("before"), false);
    await answer("retried");
    node("auditAction").value = "refreshed";
    const refreshed = status.load();
    assert.equal(requests.at(-1)!.get("action"), "refreshed");
    assert.equal(requests.at(-1)!.has("before"), false);
    await answer("refreshed");
    await refreshed;
    click("data-more-audit");
    const stale = responses.shift();
    assert.ok(stale);
    status.clear();
    status.mount();
    node("range").value = "1";
    const restored = status.load();
    assert.equal(requests.at(-1)!.has("action"), false);
    assert.equal(requests.at(-1)!.has("definition"), false);
    assert.equal(requests.at(-1)!.has("before"), false);
    await answer("restored", 1);
    await restored;
    stale(Response.json(page("stale", 1)));
    await settle();
    assert.ok(node("auditContent").innerHTML.includes("restored"));
    assert.equal(node("auditContent").innerHTML.includes("stale"), false);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
