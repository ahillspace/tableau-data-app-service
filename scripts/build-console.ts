import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export async function buildConsole(
  outdir = join(root, "dist", "console"),
): Promise<{ directory: string; files: readonly ["index.html", "index.js", "index.css"] }> {
  await mkdir(outdir, { recursive: true });
  await build({
    entryPoints: [join(root, "src/console/main.ts")],
    outfile: join(outdir, "index.js"),
    bundle: true,
    minify: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    legalComments: "none",
    logLevel: "warning",
  });
  await copyFile(join(root, "src/console/index.html"), join(outdir, "index.html"));
  return { directory: outdir, files: ["index.html", "index.js", "index.css"] };
}
if (import.meta.main) process.stdout.write(`${JSON.stringify(await buildConsole())}\n`);
