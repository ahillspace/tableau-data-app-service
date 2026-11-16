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
