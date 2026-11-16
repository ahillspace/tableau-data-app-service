import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSdk, SDK_BUDGET_BYTES } from "../scripts/build-sdk.ts";

test("V27 the SDK bundles to one dependency-free module under 15 KB minified", async () => {
  const { file, bytes } = await buildSdk(mkdtempSync(join(tmpdir(), "tdas-sdk-")));
  assert.ok(bytes < SDK_BUDGET_BYTES, `${bytes} bytes`);
  assert.equal(SDK_BUDGET_BYTES, 15 * 1024);
  const source = readFileSync(file, "utf8");
  assert.doesNotMatch(source, /\bimport\s*[\s{*"']/);
  assert.match(source, /export\s*\{/);
  const sdk = await import(file);
  assert.equal(typeof sdk.createService, "function");
  assert.equal(typeof sdk.ServiceError, "function");
});

test("the SDK resends only after the service's own sign-in-required, never after another 401", async () => {
  const { createService } = await import("../src/sdk/index.ts");
  const calls: string[] = [];
  let answer: () => Response = () => new Response("{}");
  const marked = (code: string) =>
    new Response(JSON.stringify({ error: { code, message: code } }), {
      status: 401,
      headers: { "content-type": "application/json", "tableau-service-error": "1" },
    });
  const fetch = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path === "/v1/session/restore")
      return Response.json({
        bearer: `b-${calls.length}`,
        session: { identity: {}, appId: "a", attribution: {}, expiresAt: "2999-01-01T00:00:00Z" },
      });
    return answer();
  }) as typeof globalThis.fetch;
  const service = createService({
    origin: "https://service.test",
    appId: "a",
    attribution: {},
    fetch,
  });
  assert.equal(await service.restore(), true);
  const native = () => service.fetch("files", "/charge", { method: "POST", body: "once" });

  // A marked 401 that is not sign-in-required comes back once, with no restore.
  answer = () => marked("tableau-sign-in-denied");
  calls.length = 0;
  await assert.rejects(native(), { code: "tableau-sign-in-denied" });
  assert.deepEqual(calls, ["/v1/native/files/charge"]);

  // An unmarked 401 is the provider's and is returned as is.
  answer = () => new Response("no", { status: 401 });
  calls.length = 0;
  assert.equal((await native()).status, 401);
  assert.deepEqual(calls, ["/v1/native/files/charge"]);

  // The service's own sign-in-required restores and resends once.
  let first = true;
  answer = () => {
    if (!first) return new Response("ok");
    first = false;
    return marked("sign-in-required");
  };
  calls.length = 0;
  assert.equal(await (await native()).text(), "ok");
  assert.deepEqual(calls, [
    "/v1/native/files/charge",
    "/v1/session/restore",
    "/v1/native/files/charge",
  ]);
});
