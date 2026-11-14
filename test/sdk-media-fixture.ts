import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

// Standard WebM initialization and Cluster chunks let the browser fixture append bounded ranges.
const run = promisify(execFile);
if (!process.argv[2]) throw new Error("Usage: tsx test/sdk-media-fixture.ts <new-media-directory>");
const destination = resolve(process.argv[2]);
const { mkdir } = await import("node:fs/promises");
await mkdir(destination); // Do not overwrite evidence from another run.
const scratch = await mkdtemp(join(tmpdir(), "sdk-media-"));
try {
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=160x90:rate=10",
    "-t",
    "4",
    "-an",
    "-c:v",
    "libvpx",
    "-g",
    "10",
    "-keyint_min",
    "10",
    "-map",
    "0:v",
    "-f",
    "webm_chunk",
    "-header",
    join(scratch, "init.webm"),
    join(scratch, "chunk%02d.webm"),
  ]);
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=green:s=64x48",
    "-frames:v",
    "1",
    join(destination, "image.png"),
  ]);
  const parts = [
    "init.webm",
    ...(await readdir(scratch)).filter((name) => name.startsWith("chunk")).sort(),
  ];
  const buffers = await Promise.all(parts.map((name) => readFile(join(scratch, name))));
  let offset = 0;
  const ranges = buffers.map((bytes) => {
    const start = offset;
    offset += bytes.length;
    return [start, offset - 1];
  });
  await writeFile(join(destination, "video.webm"), Buffer.concat(buffers));
  await writeFile(join(destination, "index.json"), JSON.stringify({ duration: 4, ranges }));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
