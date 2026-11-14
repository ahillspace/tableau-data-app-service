/* Run with REVIEW_PLAYWRIGHT pointing to a local playwright-core installation. */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { chromium } = require(
  process.env.REVIEW_PLAYWRIGHT || "playwright-core",
);
const root = __dirname;
const htmlPath = path.resolve(root, "../../docs/specification.html");
const output = process.env.REVIEW_OUTPUT_DIR || root;
fs.mkdirSync(path.join(output, "screenshots"), {recursive:true});
let browser;
(async () => {
  browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("file://" + htmlPath);
  await page.waitForSelector("#product-overview h2");
  assert.doesNotMatch(await page.locator("body").innerText(), /New document review pending|Document and runtime proof pending/);
  const results = [];
  const referenceErrors = await page.evaluate(() => {
    const errors = [];
    const all = [...MODEL.components, ...MODEL.modules];
    for (const api of MODEL.apis)
      if (!all.some((c) => c.id === api.component))
        errors.push("API owner " + api.id);
    for (const flow of MODEL.flows)
      for (const step of flow.steps)
        for (const id of step.edges.flat())
          if (!all.some((c) => c.id === id)) errors.push("Flow node " + id);
    for (const node of MODEL.diagram.nodes)
      if (!all.some((c) => c.id === node.id))
        errors.push("Diagram node " + node.id);
    for (const a of document.querySelectorAll("a[data-source]"))
      if (!MODEL.sources.some((s) => s.id === a.dataset.source))
        errors.push("Source link " + a.dataset.source);
    for (const a of document.querySelectorAll("a[data-api]"))
      if (!MODEL.apis.some((s) => s.id === a.dataset.api))
        errors.push("API link " + a.dataset.api);
    const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
    if (new Set(ids).size !== ids.length) errors.push("Duplicate HTML IDs");
    return errors;
  });
  assert.deepEqual(referenceErrors, []);

  const record = (name, value) => results.push({ name, result: value });
  record(
    "Model ownership, graph references, cross-links and unique HTML IDs",
    true,
  );
  for (const width of [1440, 1100, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1100 });
    for (const view of [
      "overview",
      "system",
      "flows",
      "modules",
      "api",
      "decisions",
      "plan",
      "sources",
    ]) {
      await page.locator(`a[data-view="${view}"]`).click();
      await page.waitForTimeout(50);
      const overflow = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth,
        viewport: innerWidth,
      }));
      assert(
        overflow.page <= overflow.viewport + 1,
        `${view} overflows at ${width}: ${JSON.stringify(overflow)}`,
      );
      await page.screenshot({
        path: path.join(output, `screenshots/${view}-${width}.png`),
        fullPage: true,
      });
    }
    record(`No page overflow at ${width}px`, true);
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator('a[data-view="system"]').click();
  await page.locator('#system-diagram [data-component="worker"]').click();
  assert.match(await page.locator("#system-inspector").innerText(), /Worker/i);
  record("Diagram component opens the correct inspector", true);
  for (const [id, key, expected] of [["redis", "Enter", /Redis Pub\/Sub/], ["worker", "Space", /Worker/i]]) {
    const node = page.locator(`#system-diagram [data-component="${id}"]`);
    const before = await page.locator("#system-inspector").innerText();
    await node.focus();
    await page.keyboard.press(key);
    assert.deepEqual(errors, [], `Diagram ${key} must not throw`);
    const after = await page.locator("#system-inspector").innerText();
    assert.notEqual(after, before, `Diagram ${key} changes the inspector`);
    assert.match(after, expected);
  }
  record("Diagram Enter and Space change the inspector without JavaScript errors", true);
  await page.locator('#system-diagram [data-component="redis"]').click();
  const redisInspector = await page.locator("#system-inspector").innerText();
  assert.match(redisInspector, /Redis Pub\/Sub/);
  assert.match(redisInspector, /No Redis client or deployment when events are disabled/);
  assert.match(redisInspector, /auth, native proxy, durable Jobs and task callbacks continue/);
  await page.screenshot({path: path.join(output, "screenshots/redis-1440.png"), fullPage: true});
  await page.locator('#system-diagram [data-component="host"]').click();
  assert.match(await page.locator("#system-inspector").innerText(), /confirm termination before reusing execution capacity/);
  const topology = await page.evaluate(() => ({
    redisFanout: MODEL.flows.find(f => f.id === "F05").steps[3].edges,
    scopedLocks: MODEL.decisions.find(d => d.id === "D06").status,
    staleRestrictions: /5 GB|Desktop|bindings · jobs/.test(MODEL.streamingSummary + JSON.stringify(MODEL.components) + JSON.stringify(MODEL.diagram)),
  }));
  assert.deepEqual(topology.redisFanout, [["api", "redis"], ["redis", "api"]]);
  assert.equal(topology.scopedLocks, "Accepted");
  assert.equal(topology.staleRestrictions, false);
  record("Optional Redis fanout, independent core availability and accepted scoped coordination", topology);

  await page.locator('a[data-view="flows"]').click();
  assert.equal(await page.locator("#flow-diagram .edge-active").count(), 0);
  assert.match(
    await page.locator("#step-detail").innerText(),
    /Local interaction/i,
  );
  await page.locator('[data-step="0"]').focus();
  await page.keyboard.press("ArrowRight");
  assert.match(await page.locator("#step-detail").innerText(), /Step 2/i);
  for (const option of await page.locator("#flow-select option").all()) {
    const value = await option.getAttribute("value");
    await page.selectOption("#flow-select", value);
    const count = await page.locator("[data-step]").count();
    for (let i = 0; i < count; i++) {
      await page.locator(`[data-step="${i}"]`).click();
      assert.match(
        await page.locator("#step-detail").innerText(),
        new RegExp(`Step ${i + 1}`, "i"),
      );
    }
  }
  record("Every scenario and step renders", true);
  await page.selectOption("#flow-select", "F07");
  await page.locator('[data-step="5"]').click();
  assert.match(await page.locator("#step-detail").innerText(), /no saved-result disclosure transaction/);
  await page.screenshot({path:path.join(output,"screenshots/capability-flow-1440.png"),fullPage:true});
  await page.selectOption("#flow-select", "F04");
  await page.locator('[data-step="2"]').click();
  assert.match(await page.locator("#step-detail").innerText(), /Durable acceptance only after commit/);
  await page.locator('a[data-view="api"]').click();
  await page.locator("#api-search").fill("A39");
  await page.locator('[data-api-row="A39"]').click();
  assert.match(await page.locator("#api-detail").innerText(), /ordinary current request authority/i);
  await page.locator("#api-search").fill("A20");
  await page.locator('[data-api-row="A20"]').click();
  assert.match(await page.locator("#api-detail").innerText(), /Explicit durable choice/);
  await page.locator("#api-search").fill("");
  await page.locator('a[data-view="flows"]').click();
  record("Ordinary capability and explicit Job journeys navigate to their distinct contracts", true);
  await page.selectOption("#flow-select", "F05");
  await page.locator('[data-step="3"]').click();
  assert.match(await page.locator("#step-detail").innerText(), /Redis/);
  await page.screenshot({path: path.join(output, "screenshots/redis-flow-1440.png"), fullPage: true});

  await page.locator('a[data-view="api"]').click();
  await page.locator("#api-search").fill("no-such-contract-XYZ");
  assert.match(await page.locator("#api-rows").innerText(), /No API contracts/);
  await page.locator("#api-search").fill("");
  const routeCount = await page.locator("[data-api-row]").count();
  for (const row of await page.locator("[data-api-row]").all())
    await row.click();
  record(
    `All ${routeCount} API contract details render; empty filter handled`,
    true,
  );
  for (const [id, key] of [["A01", "Enter"], ["A36", "Space"]]) {
    const row = page.locator(`[data-api-row="${id}"]`);
    const before = await page.locator("#api-detail").innerText();
    await row.focus();
    await page.keyboard.press(key);
    assert.equal(await row.getAttribute("aria-selected"), "true");
    assert.notEqual(await page.locator("#api-detail").innerText(), before);
    assert.equal(await page.locator("#api-detail [data-ohp-ref]").getAttribute("data-ohp-ref"), `API-${id}`);
    assert.deepEqual(errors, [], `API row ${key} must not throw`);
  }
  record("API rows retain Enter and Space detail selection", true);
  await page.locator('a[data-view="modules"]').click();
  await page.locator("#module-search").fill("no-such-module-XYZ");
  assert.match(await page.locator("#module-grid").innerText(), /No modules/);
  await page.locator("#module-search").fill("");
  for (const card of await page.locator(".module-card").all())
    await card.click();
  record("Every module opens; empty filter handled", true);
  await page.locator('a[data-view="decisions"]').click();
  assert.equal(await page.locator("[data-pick]").count(), 0);
  assert.equal(await page.locator("#decision-list .decision-card").count(), 8);
  assert.match(await page.locator("#decision-D01-queue").innerText(), /604800/);
  assert.match(await page.locator("#decision-D02-queue").innerText(), /sole durable business-work queue/);
  assert.match(await page.locator("#decision-D05-queue").innerText(), /After provider disconnect/);
  assert.match(await page.locator("#decision-D07-queue").innerText(), /100 MB.*24 hours/s);
  const policy = await page.evaluate(() => ({
    retiredNodes: MODEL.components.filter(c => c.id === "backend"),
    retiredRoutes: MODEL.apis.filter(a => ["A06", "A28", "A29", "A30", "A38"].includes(a.id)),
    restores: MODEL.apis.some(a => a.id === "A07"),
    eventSteps: MODEL.flows.find(f => f.id === "F05").steps.length,
    localClose: MODEL.flows.find(f => f.id === "F01").steps.at(-1).edges,
    summaries: MODEL.summary.every(s => s.label && s.title && s.detail),
  }));
  assert.deepEqual(policy.retiredNodes, []);
  assert.deepEqual(policy.retiredRoutes, []);
  assert.equal(policy.restores, true);
  assert.equal(policy.eventSteps, 7);
  assert.deepEqual(policy.localClose, [["browser", "browser"]]);
  assert.equal(policy.summaries, true);
  record("Accepted scope and policies are read-only; retired consumers/routes absent; restoration retained", policy);
  const sources = await page.evaluate(() => MODEL.sources.map(s => ({path:s.path, sha256:s.sha256, content:s.content})));
  for (const source of sources) {
    const bytes = fs.readFileSync(path.resolve(root, "../..", source.path));
    assert.equal(source.sha256, crypto.createHash("sha256").update(bytes).digest("hex"), source.path);
    assert.equal(source.content, bytes.toString("utf8"), source.path);
  }
  record("Every embedded canonical source matches current filesystem bytes and SHA-256", sources.length);
  const publicHtml = fs.readFileSync(htmlPath, "utf8");
  assert(!/\/home\/|\/Users\/|ahillspace|solutions engineering team|Google\/Salesforce|Google\/staff/i.test(publicHtml));
  const privateMetadata = await page.evaluate(() => MODEL.sources.some(s => 'absolutePath' in s || 'openCommand' in s));
  assert.equal(privateMetadata, false);
  record("Public artifact excludes workstation metadata and private audience/enrollment context", true);
  await page.locator('a[data-view="sources"]').click();
  await page.locator('[data-source-lens="limits"]').click();
  const limitCount = fs.readFileSync(path.resolve(root, "../../docs/verification.md"), "utf8").split("\n").filter(line => /^\| L\d\d /.test(line)).length;
  assert.equal(await page.locator("#limits-rows tr").count(), limitCount);
  await page.locator("#limits-search").fill("no-such-limit-XYZ");
  assert.match(
    await page.locator("#limits-rows").innerText(),
    /No limitations/,
  );
  await page.locator("#limits-search").fill("");
  await page.locator('[data-source-lens="evidence"]').click();
  assert.equal(await page.locator("#evidence-gates article").count(), 5);
  await page.locator('[data-source-lens="snapshots"]').click();
  record(
    `All ${limitCount} current limitations search correctly; all five evidence gates render`,
    true,
  );
  await page.locator('#document-index [data-source="contracts"]').click();
  assert(await page.locator('#source-doc-contracts .document-details').getAttribute('open') !== null);
  assert.match(await page.locator('#source-doc-contracts .document-content').innerText(), /JobView/);
  const manifest = JSON.parse(fs.readFileSync(path.resolve(root, "../../specification.json"), "utf8"));
  assert.deepEqual(sources.map(s => s.path), manifest.documents.map(s => s.path));
  assert(sources.some(s => s.path === 'docs/product.md'));
  assert(sources.some(s => s.path === 'docs/verification.md'));
  assert(sources.every(s => s.path.startsWith('docs/') && !s.path.includes('..')));
  const documentChecks = await page.evaluate(() => {
    const bad = [];
    for (const a of document.querySelectorAll('.document-content a[data-source]')) {
      const root = document.getElementById('source-doc-' + a.dataset.source);
      if (!root) bad.push('missing document ' + a.dataset.source);
      if (a.dataset.anchor && !document.getElementById(`doc-${a.dataset.source}-${a.dataset.anchor}`)) bad.push('missing heading ' + a.dataset.anchor);
    }
    return bad;
  });
  assert.deepEqual(documentChecks, []);
  await page.locator('a[data-view="overview"]').click();
  assert(await page.locator('#product-overview').isVisible());
  assert((await page.locator('#product-requirements').innerText()).length > 5000);
  await page.locator('#prd-toc a').last().click();
  const headingVisible = await page.evaluate(() => {
    const id = document.querySelector('#prd-toc a:last-child').dataset.scrollId;
    return !document.getElementById(id).closest('[hidden]');
  });
  assert(headingVisible);
  await page.locator('a[data-view="sources"]').click();
  await page.locator('#document-index [data-source="prd"]').click();
  const embeddedLink = page.locator('#source-doc-prd .document-content a[data-source][data-anchor]:not([data-anchor=""])').first();
  if (await embeddedLink.count()) {
    const dest = await embeddedLink.getAttribute('data-source');
    const anchor = await embeddedLink.getAttribute('data-anchor');
    await embeddedLink.click();
    await page.waitForTimeout(50);
    assert(await page.locator(`#source-doc-${dest} .document-details`).getAttribute('open') !== null);
    assert(await page.locator(`[id="doc-${dest}-${anchor}"]`).isVisible());
  }
  record("Complete current manifest, readable PRD, offline document navigation and all internal anchors", true);
  // Expand source bodies before measuring the narrow reading journey.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('a[data-view="sources"]').click();
  await page.locator('[data-source-lens="snapshots"]').click();
  const documentIds = await page.evaluate(() => ["contracts", ...MODEL.sources.filter(s => s.id !== "contracts").map(s => s.id)]);
  for (const id of documentIds) {
    while (await page.locator('.document-details[open] > summary').count())
      await page.locator('.document-details[open] > summary').first().click();
    await page.locator(`#document-index [data-source="${id}"]`).click();
    const dimensions = await page.evaluate(id => {
      const article = document.getElementById('source-doc-' + id);
      return {
        viewport: innerWidth, page: document.documentElement.scrollWidth,
        article: article.getBoundingClientRect().width,
        codeScrollsLocally: [...article.querySelectorAll('pre')].some(pre => pre.scrollWidth > pre.clientWidth),
      };
    }, id);
    if (id === "contracts") await page.screenshot({path: path.join(output, "screenshots/source-contracts-390.png"), fullPage: true});
    assert(dimensions.page <= dimensions.viewport + 1, `${id} expanded source overflows at 390px: ${JSON.stringify(dimensions)}`);
    assert(dimensions.article <= dimensions.viewport, `${id} source article exceeds viewport`);
    if (id === "contracts") assert(dimensions.codeScrollsLocally, "Long contract code retains local horizontal scrolling");
  }
  record(`All ${sources.length} expanded source documents fit the 390px page; long code scrolls locally`, true);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.emulateMedia({ media: "print" });
  assert.equal(await page.locator("#print-review .print-page").count(), 9);
  assert(await page.locator("#print-review").isVisible());
  assert.match(await page.locator("#print-review .print-page").nth(1).innerText(), /Replicable API and worker, Postgres, optional Redis/);
  assert.match(await page.locator("#print-review .print-page").nth(4).innerText(), /A07/);
  assert.match(await page.locator("#print-review .print-page").nth(5).innerText(), /A37/);
  await page.pdf({
    path: path.join(output, "screenshots/review-print.pdf"),
    printBackground: true,
    preferCSSPageSize: true,
  });
  const pdfInfo = execFileSync("pdfinfo", [path.join(output,"screenshots/review-print.pdf")], {encoding:"utf8"});
  assert.match(pdfInfo, /^Pages:\s+9$/m, "Print summary must occupy nine pages without orphan overflow");
  record(
    "Print covers overview and seven review topics once; full specification remains in HTML",
    true,
  );
  await page.emulateMedia({ media: "screen" });
  // Exercise same-origin srcdoc behavior without creating or publishing an Overhead.
  const html = fs.readFileSync(
    htmlPath,
    "utf8",
  );
  await page.setContent(
    '<iframe id="review-host" style="border:0;width:100%;height:100vh" title="Review content"></iframe>',
  );
  await page
    .locator("iframe")
    .evaluate((frame, content) => (frame.srcdoc = content), html);
  const frame = page.frameLocator("#review-host");
  await frame.locator("#product-overview h2").first().waitFor();
  await frame.locator('a[data-view="flows"]').click();
  await frame.locator("#next-step").click();
  assert.match(await frame.locator("#step-detail").innerText(), /Step 2/i);
  await page.screenshot({
    path: path.join(output, "screenshots/srcdoc-1440.png"),
    fullPage: true,
  });
  record(
    "Same-origin srcdoc iframe renders and handles flow interaction",
    true,
  );
  const readability = [];
  await page.goto("file://" + htmlPath);
  for (const width of [1066, 626]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.locator('a[data-view="flows"]').click();
    const sizing = await page.evaluate(() => ({
      layout: getComputedStyle(document.querySelector(".flow-layout")).display,
      diagram: document.querySelector("#flow-diagram svg").getBoundingClientRect().width,
      canvas: document.querySelector("#flow-diagram").getBoundingClientRect().width,
      page: document.documentElement.scrollWidth,
      viewport: innerWidth,
    }));
    assert(sizing.page <= sizing.viewport + 1);
    assert(sizing.diagram >= 770, "Diagram labels must not shrink to fit a narrow viewport");
    readability.push(sizing);
    await page.screenshot({path:path.join(output, `screenshots/readability-flow-${width}.png`),fullPage:true});
  }
  fs.writeFileSync(path.join(output, "readability-checks.json"), JSON.stringify({checkedAt:new Date().toISOString(),scope:"Current flow readability at narrow iframe widths",htmlSha256:crypto.createHash("sha256").update(html).digest("hex"),checks:readability,browserErrors:errors},null,2)+"\n");
  assert.deepEqual(errors, []);
  record("Browser JavaScript errors", errors);
  fs.writeFileSync(
    path.join(output, "ui-checks.json"),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        htmlSha256: crypto.createHash("sha256").update(html).digest("hex"),
        sourceManifest: "specification.json",
        browser: await browser.version(),
        scope:
          "Standalone file and same-origin srcdoc harness; not a published OHP session",
        results,
      },
      null,
      2,
    ) + "\n",
  );
  await browser.close();
  console.log(JSON.stringify(results, null, 2));
})().catch(async (e) => {
  if (browser) await browser.close();
  console.error(e);
  process.exitCode = 1;
});
