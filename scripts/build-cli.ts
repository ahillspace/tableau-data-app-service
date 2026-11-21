import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import pkg from "../package.json" with { type: "json" };

const root = fileURLToPath(new URL("../", import.meta.url));
const release = join(root, "dist", "release");
const staging = await mkdtemp(join(tmpdir(), "tdas-cli-pack-"));

try {
  await mkdir(release, { recursive: true });
  await build({
    entryPoints: [join(root, "dist", "cli", "tdas.js")],
    outfile: join(staging, "tdas.js"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node26",
    external: ["@napi-rs/keyring"],
  });
  await writeFile(
    join(staging, "package.json"),
    JSON.stringify(
      {
        name: "tdas-cli",
        version: pkg.version,
        description: "Tableau Data App Service CLI",
        type: "module",
        engines: pkg.engines,
        bin: { tdas: "tdas.js" },
        files: ["tdas.js"],
        dependencies: { "@napi-rs/keyring": pkg.dependencies["@napi-rs/keyring"] },
      },
      null,
      2,
    ),
  );
  execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", release], {
    cwd: staging,
    stdio: "inherit",
  });
  const filename = `tdas-cli-${pkg.version}.tgz`;
  const archive = await readFile(join(release, filename));
  await writeFile(
    join(release, "cli.json"),
    JSON.stringify({
      filename,
      version: pkg.version,
      bytes: archive.byteLength,
      sha256: createHash("sha256").update(archive).digest("hex"),
      nodeRange: pkg.engines.node,
    }),
  );
  await cp(join(root, "docs", "specification.html"), join(release, "specification.html"));
  const example = join(release, "example", "index.html");
  await mkdir(dirname(example), { recursive: true });
  await cp(join(root, "examples", "discovery", "index.html"), example);
} finally {
  await rm(staging, { recursive: true, force: true });
}
