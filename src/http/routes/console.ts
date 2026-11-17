import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { ServiceError } from "../../platform/errors.ts";
import type { Services } from "../services.ts";

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";
/** Fixed local assets share the API origin and never carry an authentication bearer. */
export function consoleRoutes(app: FastifyInstance, services: Services): void {
  if (!services.consoleEnabled) return;
  const root = new URL("../../console/", import.meta.url);
  // Source execution and compiled execution both serve the same production build output.
  const assetRoot = import.meta.url.endsWith(".ts")
    ? new URL("../../../dist/console/", import.meta.url)
    : root;
  for (const [route, file, contentType] of [
    ["/console", "index.html", "text/html; charset=utf-8"],
    ["/console/assets/index.js", "index.js", "text/javascript; charset=utf-8"],
    ["/console/assets/index.css", "index.css", "text/css; charset=utf-8"],
  ]) {
    app.get(route as string, async (_request, reply) => {
      let contents: Buffer;
      try {
        contents = await readFile(new URL(file as string, assetRoot));
      } catch {
        throw new ServiceError(
          503,
          "console-assets-unavailable",
          "Build the local console assets before enabling the console",
        );
      }
      return reply
        .header("content-security-policy", CSP)
        .header("referrer-policy", "no-referrer")
        .header("x-frame-options", "DENY")
        .type(contentType as string)
        .send(contents);
    });
  }
  app.get("/console/", (_request, reply) => reply.redirect("/console"));
}
