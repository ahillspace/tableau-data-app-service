import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";
import { build } from "esbuild";
import { z } from "zod";
import type { IdentityAdapter } from "../src/access/adapters.js";
import { closedEnrollmentGuard, SessionService } from "../src/access/sessions.js";
import { ConnectionService } from "../src/connections/service.js";
import { createHttpApp } from "../src/http/app.js";
import { registerCoreRoutes } from "../src/http/core-routes.js";
import { registerSessionRoutes } from "../src/http/session-routes.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { randomSecret } from "../src/security/secrets.js";
import { candidate, coreFixture, fixtureProvider } from "./core-fixture.js";

// Explicit synthetic identity/provider fixture. It is not selected by production configuration.
const directory = new URL("../examples/slack/", import.meta.url);
const f = await coreFixture();
const requests: {
  method: string;
  path: string;
  length: number;
  tunneledSecret: boolean;
  range?: string;
}[] = [];
const upstream = createServer(async (request, response) => {
  let length = 0;
  for await (const bytes of request) length += bytes.length;
  requests.push({
    method: request.method!,
    path: request.url!,
    length,
    ...(request.headers.range ? { range: request.headers.range } : {}),
    tunneledSecret: Object.keys(request.headers).some((name) => name.startsWith("x-integration-")),
  });
  if (request.headers.authorization !== "Bearer fixture-slack") {
    response.writeHead(401);
    response.end();
    return;
  }
  if (["/api/image.png", "/api/video.webm", "/api/download.txt"].includes(request.url ?? "")) {
    const bytes =
      request.url === "/api/download.txt"
        ? Buffer.from("authenticated download fixture\n")
        : await readFile(
            join(
              process.env.SDK_TEST_MEDIA!,
              request.url!.endsWith(".png") ? "image.png" : "video.webm",
            ),
          );
    response.setHeader(
      "Content-Type",
      request.url!.endsWith(".png")
        ? "image/png"
        : request.url!.endsWith(".webm")
          ? "video/webm"
          : "text/plain",
    );
    response.setHeader("Accept-Ranges", "bytes");
    if (request.headers.range) {
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range);
      if (!range || Number(range[2]) >= bytes.length || Number(range[1]) > Number(range[2])) {
        response.writeHead(416);
        response.end();
        return;
      }
      const start = Number(range[1]),
        end = Number(range[2]);
      response.statusCode = 206;
      response.setHeader("Content-Range", `bytes ${start}-${end}/${bytes.length}`);
      response.setHeader("Content-Length", end - start + 1);
      response.end(bytes.subarray(start, end + 1));
    } else {
      response.setHeader("Content-Length", bytes.length);
      response.end(bytes);
    }
    return;
  }
  if (request.url === "/api/redirect") {
    response.writeHead(307, { location: "/api/next", "x-integration-origin": "service" });
    response.end("native redirect");
    return;
  }
  if (request.url === "/api/stream") {
    response.writeHead(200);
    response.write("first chunk\n");
    return;
  }
  if (request.url === "/api/late") {
    response.writeHead(200);
    response.write("partial before failure\n");
    setTimeout(() => response.destroy(), 100);
    return;
  }
  response.setHeader("Content-Type", "application/json");
  response.end(
    JSON.stringify({ ok: true, team: "Fixture workspace", method: request.method, bytes: length }),
  );
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamAddress = upstream.address();
if (!upstreamAddress || typeof upstreamAddress === "string")
  throw new Error("No fixture upstream port");
let route: (
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
) => void = (_request, response) => {
  response.writeHead(503);
  response.end();
};
const https = createHttpsServer(
  {
    key: await readFile(process.env.SDK_TEST_KEY!),
    cert: await readFile(process.env.SDK_TEST_CERT!),
  },
  (request, response) => route(request, response),
);
await new Promise<void>((resolve) => https.listen(0, "127.0.0.1", resolve));
const address = https.address();
if (!address || typeof address === "string") throw new Error("No fixture HTTPS port");
const origin = `https://127.0.0.1:${address.port}`;
let enrollmentOpen = true;
const fixtureGuard = {
  get available() {
    return enrollmentOpen;
  },
  async check() {
    if (!enrollmentOpen) return closedEnrollmentGuard.check("", "launch", new Headers());
    return { profile: "explicit-browser-test-fixture-no-enrollment-proof" };
  },
};
const adapter: IdentityAdapter = {
  id: "fixture",
  deploymentId: "cloud",
  callbackUri: `${origin}/v1/session/callback/fixture`,
  async begin() {
    const state = {
      state: randomSecret(),
      verifier: randomSecret(),
      nonce: randomSecret(),
      clientId: "test",
      deviceId: "test",
    };
    return {
      authorizationUrl: `${origin}/v1/session/callback/fixture?state=${state.state}&code=fixture`,
      protectedState: state,
    };
  },
  async complete() {
    return {
      deploymentId: "cloud",
      siteId: "site",
      subjectId: "alice",
      adapterId: "fixture",
      verifiedAt: new Date(),
    };
  },
};
const sessions = new SessionService(
  f.db,
  f.access,
  f.secrets,
  new Map([["cloud", adapter]]),
  fixtureGuard,
  10000,
);
const provider = {
  ...fixtureProvider,
  id: "slack",
  endpoints: {
    api: {
      baseUrl: `http://127.0.0.1:${upstreamAddress.port}/api`,
      allowHttp: true,
      privateCidrs: ["127.0.0.1/32"],
    },
  },
  staticSetup: {
    remote: false,
    mayInvalidate: false,
    inputSchema: z.strictObject({ token: z.literal("fixture-token"), tokenMode: z.literal("bot") }),
    async prepare() {
      return candidate("fixture-slack");
    },
  },
};
await f.db
  .insertInto("provider_registrations")
  .values({
    id: "slack",
    enabled: true,
    mode: "personal",
    config_revision: 1,
    reauth_seconds: null,
  })
  .execute();
const providers = new ProviderRegistry([fixtureProvider, provider]);
const connections = new ConnectionService(f.db, f.access, f.secrets, providers, {
  connectTimeoutMs: 1000,
  headersTimeoutMs: 1000,
  stallTimeoutMs: 2000,
  maxSockets: 16,
});
const app = await createHttpApp({ db: f.db });
registerCoreRoutes(app, {
  access: f.access,
  credentials: f.credentials,
  connections,
  providers,
  corsOrigins: [origin, "null"],
  jsonPreparationBytes: 65536,
});
registerSessionRoutes(app, sessions, origin);
const configuration = { serviceOrigin: origin, appId: "one", deploymentId: "cloud" };
const bundled = await build({
  entryPoints: [new URL("app.ts", directory).pathname],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  target: "es2024",
  define: { EXAMPLE_CONFIGURATION: JSON.stringify(configuration) },
  footer: {
    js: `let storageAvailable=true;try{localStorage.length}catch{storageAvailable=false}parent.postMessage({type:"fixture-runtime",origin:self.origin,storageAvailable},"*");`,
  },
});
const mediaBundle = await build({
  entryPoints: [new URL("sdk-browser-media.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  target: "es2024",
  define: { EXAMPLE_CONFIGURATION: JSON.stringify(configuration) },
});
const popupBundle = await build({
  entryPoints: [new URL("sdk-browser-popup.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  target: "es2024",
  define: { EXAMPLE_CONFIGURATION: JSON.stringify(configuration) },
});
const harness = await build({
  stdin: {
    contents: `import {ServiceClient} from './src/sdk/index.ts';import {correlatedPopup} from './src/sdk/handoff.ts';Object.assign(window,{sdk:{ServiceClient,correlatedPopup}});`,
    resolveDir: new URL("../", import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  target: "es2024",
});
app.get("/", async (_request, reply) =>
  reply.type("text/html").send(await readFile(new URL("index.html", directory))),
);
app.get("/style.css", async (_request, reply) =>
  reply.type("text/css").send(await readFile(new URL("style.css", directory))),
);
app.get("/app.js", async (_request, reply) =>
  reply.type("text/javascript").send(bundled.outputFiles![0]!.contents),
);
app.get("/harness.js", async (_request, reply) =>
  reply.type("text/javascript").send(harness.outputFiles![0]!.contents),
);
app.get("/media.js", async (_request, reply) =>
  reply.type("text/javascript").send(mediaBundle.outputFiles![0]!.contents),
);
app.get("/popup.js", async (_request, reply) =>
  reply.type("text/javascript").send(popupBundle.outputFiles![0]!.contents),
);
app.get("/popup/:case", async (request, reply) => {
  const { case: mode } = z
    .object({
      case: z.enum([
        "valid",
        "wrong-window",
        "wrong-origin",
        "wrong-transaction",
        "closed",
        "aborted",
        "null-origin",
      ]),
    })
    .parse(request.params);
  return reply
    .type("text/html")
    .send(
      `<!doctype html><html><body data-case="${mode}"><button id="launch">Check ${mode}</button><p id="status">Ready</p><script type="module" src="/popup.js"></script></body></html>`,
    );
});
app.get("/popup-sandbox", async (_request, reply) =>
  reply
    .type("text/html")
    .send(
      '<!doctype html><html><body><iframe title="Inherited opaque popup test" sandbox="allow-scripts allow-popups" src="/popup/null-origin"></iframe></body></html>',
    ),
);
app.get("/media", async (_request, reply) =>
  reply
    .type("text/html")
    .send(
      '<!doctype html><html><body><p id="status" role="status">Loading authenticated media…</p><button id="download" disabled>Download fixture</button><script type="module" src="/media.js"></script></body></html>',
    ),
);
app.get("/media-embedded", async (_request, reply) =>
  reply
    .type("text/html")
    .send(
      '<!doctype html><html><body><iframe title="Opaque media consumer" sandbox="allow-scripts allow-downloads" src="/media" style="border:0;width:100%;height:100vh"></iframe></body></html>',
    ),
);
app.get("/harness", async (_request, reply) =>
  reply
    .type("text/html")
    .send(
      '<!doctype html><html><body><button id="launch">Launch</button><script type="module" src="/harness.js"></script></body></html>',
    ),
);
app.get("/embedded", async (_request, reply) =>
  reply
    .type("text/html")
    .send(
      '<!doctype html><html><body><iframe title="Opaque Data App" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" src="/" style="border:0;width:100%;height:100vh"></iframe><script>addEventListener("message",e=>{if(e.source===document.querySelector("iframe").contentWindow&&e.data?.type==="fixture-runtime")window.fixtureRuntime=e.data})</script></body></html>',
    ),
);
app.get("/fixture/metrics", async () => ({
  requests,
  transactions: (await f.db.selectFrom("session_transactions").select("id").execute()).length,
}));
app.get("/fixture/media-index", async () =>
  JSON.parse(await readFile(join(process.env.SDK_TEST_MEDIA!, "index.json"), "utf8")),
);
app.post("/fixture/hold-enrollment", async () => {
  enrollmentOpen = false;
  return { held: true };
});
app.get("/fixture/popup/:id/:mode", async (request, reply) => {
  const { id, mode } = z
    .object({ id: z.string(), mode: z.enum(["valid", "wrong-transaction", "quiet", "foreign"]) })
    .parse(request.params);
  if (mode === "foreign")
    return reply.redirect(`${origin.replace("127.0.0.1", "localhost")}/fixture/popup/${id}/valid`);
  return reply
    .type("text/html")
    .send(
      `<!doctype html><html><body>Window fixture<script>const id=${JSON.stringify(id)},target=opener||parent;if(${JSON.stringify(mode)}!=="quiet")target.postMessage({type:"integration:ready",transactionId:${JSON.stringify(mode === "wrong-transaction" ? "wrong" : id)}},"*");addEventListener("message",e=>{if(e.data?.type==="integration:proof"&&typeof e.data.initiationProof==="string"&&!e.data.accessToken)target.postMessage({type:"integration:complete",transactionId:id},"*")});</script></body></html>`,
    );
});
await app.ready();
route = (request, response) => app.routing(request, response);
process.stdout.write(`${JSON.stringify({ origin, fixture: true })}\n`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  https.closeAllConnections();
  upstream.closeAllConnections();
  await Promise.all([
    new Promise<void>((resolve) => https.close(() => resolve())),
    new Promise<void>((resolve) => upstream.close(() => resolve())),
  ]);
  await app.close();
  await f.close();
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void close();
  });
