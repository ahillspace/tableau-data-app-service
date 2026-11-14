/* Actual OHP web shell; substitute only the native server-discovery bridge. */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { chromium } = require(
  process.env.REVIEW_PLAYWRIGHT || "playwright-core",
);
const id =
  process.env.REVIEW_OHP_ID ||
  "2026-11-09_13-14-01-tableau-integration-backend-build-design-review";
const output = process.env.REVIEW_OUTPUT_DIR || __dirname;
fs.mkdirSync(path.join(output, "screenshots"), {recursive:true});
let browser;
(async () => {
  browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1720, height: 1100 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.__TAURI_INTERNALS__ = {
      invoke: async (command) => {
        if (command === "resolve_server") return "http://127.0.0.1:45907";
        throw new Error(
          "Native command intentionally unavailable in web-shell verification: " +
            command,
        );
      },
    };
  });
  await page.goto("http://127.0.0.1:1420/");
  await page.waitForFunction(async () => {
    const { store } = await import("/src/lib/stores/store.ts");
    return store.connected;
  });
  await page.evaluate(async (id) => {
    const { store } = await import("/src/lib/stores/store.ts");
    await store.openOverhead(id);
  }, id);
  const frame = page.frameLocator("iframe").first();
  await frame.locator("#overview-title").waitFor();
  const head = await page.evaluate(async () => {
    const { store } = await import("/src/lib/stores/store.ts");
    return {
      id: store.selected.id,
      headRev: store.headRev,
      mode: store.mode,
      staged: store.staged.length,
    };
  });
  assert.equal(head.id, id);
  assert(
    head.headRev > 0,
    "Parent must publish the reviewed candidate before this check",
  );
  assert.equal(head.staged, 0);
  await page.getByRole("button", { name: "Interact", exact: true }).click();
  await frame.locator('a[data-view="flows"]').click();
  await frame.locator("#flow-select").selectOption("F03");
  await frame.locator('[data-step="4"]').click();
  assert.match(await frame.locator("#step-detail").innerText(), /no arbitrary total response cap/);
  const iframeSize = await page.locator("iframe").first().boundingBox();
  await page.screenshot({
    path: path.join(output, "screenshots/ohp-shell-flow-1720.png"),
    fullPage: true,
  });
  await frame.locator('a[data-view="api"]').click();
  await frame.locator("#api-search").fill("A37");
  await frame.locator('[data-api-row="A37"]').click();
  assert.match(
    await frame.locator("#api-detail").innerText(),
    /intentionally unset/,
  );
  await page.screenshot({
    path: path.join(output, "screenshots/ohp-shell-api-1720.png"),
    fullPage: true,
  });
  await frame.locator('a[data-view="decisions"]').click();
  assert.equal(await frame.locator("[data-pick]").count(), 0);
  assert.equal(await frame.locator("#decision-list .decision-card").count(), 8);
  assert.match(await frame.locator("#decision-D01-queue").innerText(), /604800/);
  assert.match(await frame.locator("#decision-D02-queue").innerText(), /Owned Postgres Jobs table/);
  assert.match(await frame.locator("#decision-D07-queue").innerText(), /100 MB.*24 hours/s);
  await frame.locator('a[data-view="flows"]').click();
  await frame.locator("#flow-select").selectOption("F07");
  await frame.locator('[data-step="5"]').click();
  assert.match(await frame.locator("#step-detail").innerText(), /no saved-result disclosure transaction/);
  await page.screenshot({path:path.join(output,"screenshots/ohp-shell-capability.png"),fullPage:true});
  await frame.locator("#flow-select").selectOption("F04");
  await frame.locator('[data-step="2"]').click();
  assert.match(await frame.locator("#step-detail").innerText(), /Durable acceptance only after commit/);
  await frame.locator('a[data-view="api"]').click();
  for (const [api, expected] of [["A39", /Ordinary current request authority/], ["A20", /Explicit durable choice/]]) {
    await frame.locator("#api-search").fill(api);
    await frame.locator(`[data-api-row="${api}"]`).click();
    assert.match(await frame.locator("#api-detail").innerText(), expected);
  }
  const loadedHtml = await page.locator("iframe").first().getAttribute("srcdoc");
  const candidate = fs.readFileSync(path.join(__dirname,"architecture-review.html"),"utf8");
  assert.equal(loadedHtml, candidate, "Published head must match the checked candidate");
  const sources = await frame.locator("body").evaluate(() => MODEL.sources.map(({path,content,sha256}) => ({path,content,sha256})));
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname,"../../specification.json"),"utf8"));
  assert.deepEqual(sources.map(s => s.path), manifest.documents.map(s => s.path));
  for (const source of sources) {
    const bytes = fs.readFileSync(path.resolve(__dirname,"../..",source.path));
    assert.equal(source.content, bytes.toString("utf8"));
    assert.equal(source.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  }
  await page.screenshot({path:path.join(output,"screenshots/ohp-shell-accepted-decisions.png"),fullPage:true});
  const clean = await page.evaluate(async () => {
    const { store } = await import("/src/lib/stores/store.ts");
    return {staged:store.staged.length,headRev:store.headRev};
  });
  assert.equal(clean.staged, 0);
  assert.equal(clean.headRev, head.headRev);
  await page.getByRole("button", { name: "Annotate", exact: true }).click();
  await page.getByRole("button", { name: "Interact", exact: true }).click();
  await frame.locator('a[data-view="sources"]').click();
  await frame.locator('[data-source-lens="limits"]').click();
  await frame.locator("#limits-search").fill("L01");
  assert.match(await frame.locator("#limits-rows").innerText(), /no arbitrary total-byte cap/);
  await frame.locator('[data-source-lens="snapshots"]').click();
  await frame.locator('#document-index [data-source="contracts"]').click();
  assert.match(await frame.locator('#source-doc-contracts .document-content').innerText(), /JobView/);
  assert(await frame.locator('#source-doc-contracts .document-details').getAttribute('open') !== null);
  await frame.locator('a[data-view="overview"]').click();
  assert(await frame.locator('#product-requirements').isVisible());
  await page.screenshot({path:path.join(output, "screenshots/ohp-shell-overview-1720.png"),fullPage:true});
  await page.setViewportSize({ width: 1280, height: 1000 });
  await frame.locator('a[data-view="system"]').click();
  await page.screenshot({
    path: path.join(output, "screenshots/ohp-shell-system-1280.png"),
    fullPage: true,
  });
  const narrow = await page.locator("iframe").first().boundingBox();
  await frame.locator('a[data-view="flows"]').click();
  await frame.locator("#flow-select").selectOption("F03");
  await frame.locator('[data-step="4"]').click();
  assert.match(await frame.locator("#step-detail").innerText(), /no arbitrary total response cap/);
  await page.screenshot({
    path: path.join(output, "screenshots/ohp-shell-flow-1280.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(output, "ohp-shell-checks.json"),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        htmlSha256: crypto.createHash("sha256").update(candidate).digest("hex"),
        sourceManifest: "specification.json",
        scope:
          "Actual OHP web shell + live server; native desktop bridge server discovery substituted. No Send action, source update or durable decision.",
        head,
        iframeSize,
        narrowIframeSize: narrow,
        verified: [
          "Live loaded head",
          "Interact/Annotate mode toggle",
          "Native streaming flow at actual iframe width",
          "Evidence-dependent A37 plus ordinary A39 and explicit A20 contract navigation",
          "Exact published head equality and all embedded source bytes/hashes match current manifest",
          "Read-only accepted policies match the candidate; no approval controls or staged feedback",
          "Current limitation filter, overview/PRD and complete embedded contract navigation",
        ],
        clean,
        browserErrors: errors,
      },
      null,
      2,
    ) + "\n",
  );
  await browser.close();
  console.log(
    "Actual OHP web-shell checks passed; accepted decisions inspected without staging feedback.",
  );
})().catch(async (e) => {
  if (browser) await browser.close();
  console.error(e);
  process.exitCode = 1;
});
