import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { type CliDeps, tdas } from "../src/cli/tdas.ts";
import { openCredential, readDefinitionSecret } from "../src/connections/store.ts";
import { intakeFixture } from "./support/intake.ts";

test("tdas secret uses actual write-only API for stdin/file/value/clear and reports source conflicts safely", async () => {
  const f = await intakeFixture();
  const directory = await mkdtemp(join(tmpdir(), "tdas-intake-cli-"));
  try {
    const created = await f.call("/v1/admin/definitions", {
      body: {
        id: "key",
        displayName: "Key",
        ownership: "shared",
        authentication: { method: "static" },
        apiHosts: ["https://api.example"],
        audience: [f.siteId],
      },
    });
    assert.equal(created.status, 201);
    const out: string[] = [],
      err: string[] = [];
    const run = async (args: string[], stdin = "") => {
      out.length = 0;
      err.length = 0;
      const deps: CliDeps = {
        fetch,
        store: {
          get: async (key) =>
            key === "current-service" ? f.origin : key === f.origin ? f.grant.bearer : undefined,
          set: async () => {},
          delete: async () => {},
        },
        open: async () => assert.fail("secret entry must not open a browser"),
        out: (text) => out.push(text),
        err: (text) => err.push(text),
        env: {},
        secretInput: {
          stdin: Object.assign(Readable.from(stdin ? [stdin] : []), { isTTY: false }),
        },
      };
      return tdas(["definitions", "secret", ...args], deps);
    };
    assert.equal(await run(["key", "credential"], "pipe-token"), 0);
    let row = await f.db
      .selectFrom("connections")
      .selectAll()
      .where("status", "=", "connected")
      .executeTakeFirstOrThrow();
    assert.deepEqual(
      openCredential(f.c.sealer, row.id, row.sealed as NonNullable<typeof row.sealed>).input,
      { kind: "token", value: "pipe-token" },
    );
    assert.equal([...out, ...err].join("\n").includes("pipe-token"), false);
    const before = (await (await f.call("/v1/admin/definitions/key")).json()).definition;
    assert.equal(
      await run(["key", "credential", "--value", "argument-token"], "piped-conflict"),
      2,
    );
    assert.equal([...out, ...err].join("\n").includes("piped-conflict"), false);
    assert.equal(
      await run([
        "key",
        "credential",
        "--value",
        "argument-token",
        "--from-file",
        join(directory, "missing"),
      ]),
      2,
    );
    assert.equal(await run(["key", "credential", "--clear", "--value", "argument-token"]), 2);
    assert.equal(await run(["key", "credential", "--clear"], "conflict"), 2);
    assert.equal(
      (await (await f.call("/v1/admin/definitions/key")).json()).definition.version,
      before.version,
    );
    assert.equal(await run(["key", "credential", "--value", "argument-token"]), 0);
    assert.match(err.join("\n"), /shell-history/);
    assert.match(err.join("\n"), /process-list/);
    assert.equal([...out, ...err].join("\n").includes("argument-token"), false);
    assert.equal(await run(["key", "credential", "--clear"]), 0);
    assert.deepEqual(JSON.parse(out.join("\n")).definition.credential, { set: false, setAt: null });
    assert.equal(
      await run(["key", "credential"]),
      2,
      "empty stdin cannot silently clear or prompt without a TTY",
    );
    assert.equal(await run(["key", "credential", "--from-file", join(directory, "missing")]), 2);
    assert.equal(await run(["key", "clientSecret"], "not-used-by-static"), 1);
    assert.equal([...out, ...err].join("\n").includes("not-used-by-static"), false);
    row = await f.db
      .selectFrom("connections")
      .selectAll()
      .where("id", "=", row.id)
      .executeTakeFirstOrThrow();
    assert.equal(row.sealed, null, "clear deletes original credential custody");

    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const path = join(directory, "private-key.pem");
    await writeFile(path, pem, { mode: 0o600 });
    const machine = await f.call("/v1/admin/definitions", {
      body: {
        id: "machine",
        displayName: "Machine",
        ownership: "shared",
        apiHosts: ["https://api.example"],
        audience: [f.siteId],
        authentication: {
          method: "client_credentials",
          tokenEndpoint: "https://token.example/token",
          scopeParameter: { name: "scope", separator: " " },
          response: {
            format: "json",
            rules: { successStatuses: [200] },
            mapping: { accessToken: ["access_token"] },
          },
          clientAuthentication: {
            method: "private_key_jwt",
            clientId: "client",
            jwt: {
              algorithm: "RS256",
              issuer: "client",
              subject: "client",
              audience: "https://token.example/token",
              ttlSeconds: 300,
            },
          },
        },
      },
    });
    assert.equal(machine.status, 201, await machine.clone().text());
    assert.equal(await run(["machine", "signingPrivateKey", "--from-file", path]), 0);
    assert.equal(
      await readDefinitionSecret(f.db, f.c.sealer, "machine", "signingPrivateKey"),
      pem,
      "multiline PEM and final newline are exact",
    );
    assert.equal([...out, ...err].join("\n").includes(pem), false);
    assert.equal(await run(["machine", "signingPrivateKey", "--clear"]), 0);
    assert.equal(
      await readDefinitionSecret(f.db, f.c.sealer, "machine", "signingPrivateKey"),
      undefined,
    );
    assert.equal(await run(["machine", "signingPrivateKey"], `${pem}\n`), 0);
    assert.equal(
      await readDefinitionSecret(f.db, f.c.sealer, "machine", "signingPrivateKey"),
      `${pem}\n`,
    );
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("hidden terminal input runs on a real PTY, accepts editing and never echoes the secret", () => {
  const module = new URL("../src/cli/secret-input.ts", import.meta.url).href;
  const javascript = `import { readSecret } from ${JSON.stringify(module)}; import { createHash } from 'node:crypto'; const value = await readSecret(new Map(), () => {}); process.stdout.write('RESULT:'+createHash('sha256').update(value ?? '').digest('hex')+'\\n');`;
  const python = `import os, pty, select, subprocess, sys, time, hashlib, json
master, slave = pty.openpty()
child = subprocess.Popen([sys.argv[1], '--input-type=module', '-e', sys.argv[2]], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
output = b''
end = time.time() + 10
sent = False
while time.time() < end:
    ready, _, _ = select.select([master], [], [], 0.1)
    if ready:
        try: chunk = os.read(master, 65536)
        except OSError: break
        if not chunk: break
        output += chunk
        if b'Secret (hidden): ' in output and not sent:
            os.write(master, b'hidden-secreX\\x7ft\\r')
            sent = True
    if child.poll() is not None: break
if child.poll() is None: child.kill()
child.wait()
os.close(master)
expected = hashlib.sha256(b'hidden-secret').hexdigest().encode()
assert b'RESULT:' + expected in output, output
assert b'hidden-secret' not in output and b'secreX' not in output, output
print(json.dumps({'exit': child.returncode, 'hidden': True, 'edited': True}))
`;
  assert.deepEqual(
    JSON.parse(
      execFileSync("python3", ["-c", python, process.execPath, javascript], {
        encoding: "utf8",
        timeout: 15000,
      }),
    ),
    { exit: 0, hidden: true, edited: true },
  );
});
