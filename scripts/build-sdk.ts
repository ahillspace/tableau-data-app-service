/**
 * Bundles the browser SDK into one minified ES module and its type declarations, and fails when
 * the bundle reaches the size budget.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export const SDK_BUDGET_BYTES = 15 * 1024;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function buildSdk(
  outdir = join(root, "dist", "sdk"),
): Promise<{ file: string; bytes: number }> {
  mkdirSync(outdir, { recursive: true });
  const file = join(outdir, "index.js");
  await build({
    entryPoints: [join(root, "src", "sdk", "index.ts")],
    outfile: file,
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    legalComments: "none",
    logLevel: "warning",
  });
  const bytes = statSync(file).size;
  if (bytes >= SDK_BUDGET_BYTES)
    throw new Error(`The SDK is ${bytes} bytes; the budget is under ${SDK_BUDGET_BYTES}`);
  return { file, bytes };
}

export function buildSdkTypes(outdir = join(root, "dist", "sdk")): void {
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules", "typescript", "bin", "tsc"),
      join(root, "src", "sdk", "index.ts"),
      "--declaration",
      "--emitDeclarationOnly",
      "--strict",
      "--target",
      "es2024",
      "--lib",
      "es2024,dom",
      "--module",
      "nodenext",
      "--skipLibCheck",
      "--ignoreConfig",
      "--outDir",
      outdir,
    ],
    { stdio: "inherit" },
  );
}

if (import.meta.main) {
  const { file, bytes } = await buildSdk();
  buildSdkTypes();
  process.stdout.write(`${file}: ${bytes} bytes\n`);
}
