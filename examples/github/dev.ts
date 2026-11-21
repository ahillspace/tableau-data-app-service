import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { build } from "esbuild";

const directory = new URL("./", import.meta.url);
const configuration = {
  serviceOrigin: process.env.SERVICE_ORIGIN ?? "http://127.0.0.1:3000",
  appId: process.env.APP_ID ?? "github-example",
  definitionId: process.env.GITHUB_DEFINITION ?? "github",
};
const bundle = await build({
  entryPoints: [new URL("app.ts", directory).pathname],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2024",
  define: { EXAMPLE_CONFIGURATION: JSON.stringify(configuration) },
});
const server = createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  try {
    if (request.url === "/app.js") {
      response.setHeader("Content-Type", "text/javascript; charset=utf-8");
      response.end(bundle.outputFiles![0]!.contents);
    } else if (request.url === "/style.css") {
      response.setHeader("Content-Type", "text/css; charset=utf-8");
      response.end(await readFile(new URL("style.css", directory)));
    } else if (request.url === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(await readFile(new URL("index.html", directory)));
    } else {
      response.writeHead(404);
      response.end();
    }
  } catch {
    response.writeHead(500);
    response.end("Example asset unavailable");
  }
});
server.listen(Number(process.env.EXAMPLE_PORT ?? 3101), "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(
    `GitHub example: http://127.0.0.1:${typeof address === "object" ? address?.port : ""}\n`,
  );
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    server.closeAllConnections();
    server.close();
  });
