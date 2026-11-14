import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function testRedis() {
  const binary = process.env.REDIS_SERVER ?? "redis-server";
  const directory = await mkdtemp(join(tmpdir(), "tableau-events-redis-"));
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No Redis test port");
  const port = address.port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  let child: ChildProcess | undefined;
  const start = async () => {
    child = spawn(
      binary,
      [
        "--port",
        String(port),
        "--bind",
        "127.0.0.1",
        "--save",
        "",
        "--appendonly",
        "no",
        "--dir",
        directory,
        "--maxmemory",
        "32mb",
        "--client-output-buffer-limit",
        "pubsub 2mb 1mb 1",
        "--proto-max-bulk-len",
        "8mb",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const process = child;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error("Redis test startup timed out; set REDIS_SERVER to a real local binary"),
          ),
        5000,
      );
      process.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      process.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Redis exited before readiness: ${code}`));
      });
      process.stdout!.on("data", (data) => {
        if (String(data).includes("Ready to accept connections")) {
          clearTimeout(timer);
          resolve();
        }
      });
      process.stderr!.resume();
    });
  };
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    child = undefined;
  };
  try {
    await start();
  } catch (error) {
    await stop();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    url: `redis://127.0.0.1:${port}`,
    start,
    stop,
    async close() {
      await stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function eventually(check: () => boolean | Promise<boolean>, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Expected behavior did not occur before deadline");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
