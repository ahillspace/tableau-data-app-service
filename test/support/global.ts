/**
 * Starts a private Postgres (with TLS and a throwaway CA) and Redis from the developer's local
 * installations, for the whole test run. Each test file creates its own database from this server.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

let postgres: ChildProcess | undefined;
let redis: ChildProcess | undefined;
let root = "";

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

function binary(name: string): string {
  const candidates = [process.env[`TDAS_TEST_${name.toUpperCase().replace(/-/g, "_")}`]];
  try {
    const bindir = execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim();
    candidates.push(join(bindir, name));
  } catch {}
  candidates.push(name);
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {}
  }
  throw new Error(`Tests need ${name} from a local installation on PATH`);
}

function openssl(args: string[], cwd: string): void {
  execFileSync("openssl", args, { cwd, stdio: "ignore" });
}

export function makeCertificates(dir: string, commonName: string, altNames: string): void {
  openssl(
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=tdas-test-ca",
      "-keyout",
      "ca.key",
      "-out",
      "ca.crt",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign",
    ],
    dir,
  );
  openssl(
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      `/CN=${commonName}`,
      "-keyout",
      "server.key",
      "-out",
      "server.csr",
    ],
    dir,
  );
  writeFileSync(
    join(dir, "ext.cnf"),
    `subjectAltName=${altNames}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`,
  );
  openssl(
    [
      "x509",
      "-req",
      "-in",
      "server.csr",
      "-CA",
      "ca.crt",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-days",
      "2",
      "-extfile",
      "ext.cnf",
      "-out",
      "server.crt",
    ],
    dir,
  );
  execFileSync("chmod", ["600", join(dir, "server.key")]);
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${label} did not start`);
}

export async function globalSetup(): Promise<void> {
  root = mkdtempSync(join(tmpdir(), "tdas-test-"));
  const data = join(root, "pg");
  makeCertificates(root, "localhost", "DNS:localhost,IP:127.0.0.1");
  execFileSync(
    binary("initdb"),
    ["-D", data, "-U", "tdas", "--auth=trust", "-E", "UTF8", "--no-instructions"],
    { stdio: "ignore" },
  );
  const pgPort = await freePort();
  postgres = spawn(
    binary("postgres"),
    [
      "-D",
      data,
      "-p",
      String(pgPort),
      "-k",
      root,
      "-c",
      "listen_addresses=127.0.0.1",
      "-c",
      "ssl=on",
      "-c",
      `ssl_cert_file=${join(root, "server.crt")}`,
      "-c",
      `ssl_key_file=${join(root, "server.key")}`,
      "-c",
      "fsync=off",
      "-c",
      "synchronous_commit=off",
      "-c",
      "full_page_writes=off",
      "-c",
      "max_connections=300",
    ],
    { stdio: "ignore" },
  );
  const isready = binary("pg_isready");
  await waitFor(() => {
    try {
      execFileSync(isready, ["-h", "127.0.0.1", "-p", String(pgPort), "-U", "tdas"], {
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  }, "Postgres");
  process.env.TDAS_TEST_PG = `postgresql://tdas@localhost:${pgPort}/postgres`;
  process.env.TDAS_TEST_PG_CA = join(root, "ca.crt");
  process.env.TDAS_TEST_ROOT = root;

  const redisPort = await freePort();
  redis = spawn(
    binary("redis-server"),
    ["--port", String(redisPort), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"],
    {
      stdio: "ignore",
    },
  );
  await waitFor(() => {
    try {
      execFileSync(binary("redis-cli"), ["-p", String(redisPort), "ping"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }, "Redis");
  process.env.TDAS_TEST_REDIS = `redis://127.0.0.1:${redisPort}`;
  process.env.TDAS_TEST_REDIS_BIN = binary("redis-server");
}

export async function globalTeardown(): Promise<void> {
  postgres?.kill("SIGINT");
  redis?.kill("SIGINT");
  await new Promise((r) => setTimeout(r, 300));
  if (root) rmSync(root, { recursive: true, force: true });
}
