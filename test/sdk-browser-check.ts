import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const [origin, evidence] = process.argv.slice(2);
if (!origin || !evidence || !process.env.CHROME_DEVTOOLS_AXI_SESSION)
  throw new Error(
    "Pass fixture origin/evidence directory and an isolated CHROME_DEVTOOLS_AXI_SESSION",
  );
await mkdir(evidence, { recursive: true });
let step = 0;
async function cli(command: string, ...args: string[]) {
  const result = await execute("chrome-devtools-axi", [command, ...args], {
    env: process.env,
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  await writeFile(
    join(evidence!, `${String(++step).padStart(3, "0")}-${command}.txt`),
    result.stdout + result.stderr,
  );
  return result.stdout;
}
async function ref(kind: string, name: string) {
  const snapshot = await cli("snapshot");
  const line = snapshot.split("\n").find((line) => line.includes(`${kind} "${name}"`));
  const id = line && /uid=(\S+)/.exec(line)?.[1];
  if (!id) throw new Error(`Control missing: ${kind} ${name}`);
  return `@${id}`;
}
async function click(name: string) {
  return cli("click", await ref("button", name));
}
async function fill(name: string, value: string, kind = "textbox") {
  const id = await ref(kind, name);
  if (value === "") {
    await cli("click", id);
    await cli("press", "Control+A");
    return cli("press", "Backspace");
  }
  return cli("fill", id, value);
}
async function wait(text: string) {
  const deadline = Date.now() + 10000;
  while (true) {
    const snapshot = await cli("snapshot");
    if (snapshot.includes(text)) return snapshot;
    if (Date.now() > deadline) throw new Error(`UI did not show ${text}`);
  }
}
await cli("open", `${origin}/embedded`);
const start = await cli("snapshot");
await click(
  start.includes('button "Use another Tableau account"')
    ? "Use another Tableau account"
    : "Sign in with Tableau",
);
await wait("Signed in. Choose or connect a Slack account.");
await click("Connect Slack");
if (process.env.SDK_TEST_OAUTH !== "1") {
  await fill("Slack token", "fixture-token");
  await click("Connect token");
}
await wait("Slack connected.");
await click("Reconnect selected account");
if (process.env.SDK_TEST_OAUTH !== "1") {
  await fill("Slack token", "fixture-token");
  await click("Connect token");
}
await wait(process.env.SDK_TEST_OAUTH === "1" ? "Slack account reconnected." : "Slack connected.");
if (process.env.SDK_TEST_OAUTH === "1") {
  assert.ok(
    (
      await cli(
        "eval",
        "async () => (await (await fetch('/fixture/metrics')).json()).providerExchanges === 2 ? 'TWO_PKCE_EXCHANGES_CONFIRMED' : 'FAILED'",
      )
    ).includes("TWO_PKCE_EXCHANGES_CONFIRMED"),
  );
}
await click("Send request");
let snapshot = await wait("Native response complete (HTTP 200).");
assert.ok(snapshot.includes("Fixture workspace"));
await fill("Slack API path", "/redirect");
await click("Send request");
snapshot = await wait("Native response complete (HTTP 307).");
assert.ok(snapshot.includes("native redirect"));
await fill("Slack API path", "/auth.test");
await fill("Body (optional)", "read=1");
await click("Send request");
snapshot = await wait("Native response complete (HTTP 200).");
assert.ok(snapshot.includes('"method":"GET"') && snapshot.includes('"bytes":6'));
await fill("Method", "HEAD", "combobox");
await click("Send request");
await wait("Native response complete (HTTP 200).");
await fill("Method", "GET", "combobox");
await fill("Body (optional)", "");
await fill("Slack API path", "/stream");
await click("Send request");
await wait("first chunk");
await click("Stop reading");
await wait("The provider may already have processed the request.");
await fill("Slack API path", "/late");
await click("Send request");
snapshot = await wait("Request or body read failed:");
assert.ok(snapshot.includes("partial before failure"));
await cli("screenshot", join(evidence, "sample-desktop.png"));
const runtime = await cli(
  "eval",
  "() => window.fixtureRuntime?.origin === 'null' && window.fixtureRuntime?.storageAvailable === false ? 'OPAQUE_NO_STORAGE_CONFIRMED' : 'FAILED'",
);
assert.ok(runtime.includes("OPAQUE_NO_STORAGE_CONFIRMED"));
await cli("open", `${origin}/embedded`);
await wait("Session restored.");
await cli("newpage", `${origin}/embedded`);
await wait("Session restored.");
await cli("resize", "390", "844");
await cli("screenshot", join(evidence, "sample-mobile.png"));
await cli("resize", "1280", "900");
for (const mode of [
  "valid",
  "wrong-window",
  "wrong-origin",
  "wrong-transaction",
  "closed",
  "aborted",
  "null-origin",
]) {
  await cli("open", mode === "null-origin" ? `${origin}/popup-sandbox` : `${origin}/popup/${mode}`);
  await click(`Check ${mode}`);
  await wait(`passed:${mode}`);
}
await cli("open", `${origin}/media-embedded`);
await wait("Media passed:");
await cli("screenshot", join(evidence, "native-media.png"));
const downloads = process.env.SDK_TEST_DOWNLOADS;
if (!downloads)
  throw new Error("SDK_TEST_DOWNLOADS must point to the isolated browser download directory");
const before = new Set(await readdir(downloads));
await click("Download fixture");
let downloaded: string | undefined;
const deadline = Date.now() + 5000;
while (!downloaded) {
  downloaded = (await readdir(downloads)).find(
    (name) => !before.has(name) && name.endsWith(".txt"),
  );
  if (!downloaded && Date.now() > deadline)
    throw new Error("Browser did not save the authenticated fixture download");
  if (!downloaded) await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.equal(
  await readFile(join(downloads, downloaded), "utf8"),
  "authenticated download fixture\n",
);
await cli(
  "eval",
  "async () => { await fetch('/fixture/hold-enrollment',{method:'POST'}); return 'held'; }",
);
await cli("open", `${origin}/embedded`);
await wait("Session restored.");
await click("Use another Tableau account");
await wait("Initial authentication is unavailable pending verified browser enrollment");
await cli("stop");
await cli("start");
await cli("open", `${origin}/embedded`);
await wait("Session restored.");
await writeFile(
  join(evidence, "result.json"),
  JSON.stringify(
    {
      passed: true,
      fixture: true,
      runtime: process.version,
      checks: [
        "opaque UI sign-in proof/redemption",
        process.env.SDK_TEST_OAUTH === "1"
          ? "provider OAuth connect/reconnect controls and actual PKCE token exchange"
          : "static connect/reconnect controls",
        "native GET",
        "307 no-follow",
        "GET body carrier",
        "HEAD empty carrier",
        "body cancellation",
        "late body failure",
        "reload restore",
        "new-tab restore",
        "browser-restart restore",
        "opaque storage unavailable",
        "desktop/mobile screenshots",
        "popup origin/window/transaction/close/abort/null-origin",
        "actual image decode",
        "MediaSource video render and authenticated 206 seek",
        "small authenticated browser download",
        "closed first-enrollment guard surfaced without fallback",
      ],
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write("Browser sample checks passed (synthetic identity/provider fixtures only).\n");
