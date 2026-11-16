import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import { createEvents } from "../src/events/index.ts";
import { RedisEventBus } from "../src/events/redis.ts";
import { EventService, STREAM_BUFFER, type StreamSink } from "../src/events/service.ts";
import { addSite, listSites } from "../src/identity/directory.ts";
import type { Principal, SignInSession } from "../src/identity/types.ts";
import type { Db } from "../src/persistence/database.ts";
import { ServiceError } from "../src/platform/errors.ts";
import { Log } from "../src/platform/log.ts";
import { slack } from "../src/presets/slack.ts";
import { type ConnectionsHarness, connectionsHarness } from "./support/connections.ts";
import { freshDatabase, testKeys } from "./support/db.ts";
import {
  appSignIn,
  DEPLOYMENT,
  type IdentityHarness,
  identityHarness,
  operatorSignIn,
  tableauSignIn,
} from "./support/identity.ts";
import { TableauStandIn, type TableauUser } from "./support/tableau.ts";

const SECRET = "events-signing-secret";
const alice: TableauUser = {
  siteId: "site-a",
  siteContentUrl: "alpha",
  userId: "user-a",
  userName: "alice@example.com",
};
const carol: TableauUser = {
  siteId: "site-b",
  siteContentUrl: "beta",
  userId: "user-c",
  userName: "carol@example.com",
};
const operatorUser: TableauUser = {
  siteId: "site-a",
  siteContentUrl: "alpha",
  userId: "user-op",
  userName: "op@example.com",
};

class Sink implements StreamSink {
  chunks: string[] = [];
  full = false;
  ended = false;
  #drain: (() => void) | undefined;
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return !this.full;
  }
  onDrain(listener: () => void): void {
    this.#drain = listener;
  }
  drain(): void {
    this.full = false;
    this.#drain?.();
  }
  end(): void {
    this.ended = true;
  }
  frames(): { event: string; data: Record<string, unknown> }[] {
    return this.chunks
      .filter((c) => c.includes("event: "))
      .map((c) => ({
        event: /event: (.*)\n/.exec(c)?.[1] as string,
        data: JSON.parse(/data: (.*)\n/.exec(c)?.[1] as string),
      }));
  }
}

function signedDelivery(payload: unknown) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return {
    headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
    body: Buffer.from(body),
  };
}

const message = (id: string) => ({
  type: "event_callback",
  team_id: "T1",
  event_id: id,
  event: { type: "message" },
});

async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

describe("events", () => {
  let tableau: TableauStandIn;
  let db: Db;
  let closeDb: (() => Promise<void>) | undefined;
  let h: IdentityHarness;
  let c: ConnectionsHarness;
  let a: Principal;
  let carolPrincipal: Principal;
  const services: EventService[] = [];

  const replica = async (url = process.env.TDAS_TEST_REDIS as string) => {
    const lines: string[] = [];
    const service = new EventService({
      bus: new RedisEventBus({ url, log: new Log((l) => lines.push(l)) }),
      connections: c.connections,
      clock: h.clock,
      log: new Log((l) => lines.push(l)),
      sessionValid: async () => true,
    });
    await service.start();
    services.push(service);
    return { service, lines };
  };

  before(async () => {
    tableau = await new TableauStandIn().start();
  });
  after(async () => {
    for (const s of services.splice(0)) await s.close();
    await h.close();
    await closeDb?.();
    await tableau.close();
  });
  beforeEach(async () => {
    for (const s of services.splice(0)) await s.close();
    if (closeDb) {
      await h.close();
      await closeDb();
    }
    ({ db, close: closeDb } = await freshDatabase());
    h = await identityHarness(db, tableau);
    c = connectionsHarness(db, {
      keys: testKeys(),
      outbound: h.outbound,
      clock: h.clock,
      presets: [slack],
    });
    const op = await tableauSignIn(h, tableau, operatorUser);
    const opSession = (await h.identity.readSignInSession(op.cookie)) as SignInSession;
    const opPrincipal = (await operatorSignIn(h, op.cookie)).principal;
    const alpha = ((await listSites(db))[0] as { id: string }).id;
    await addSite(db, "test", { deploymentId: DEPLOYMENT, contentUrl: "beta" });
    for (const [id, ownership] of [
      ["slack-bot", "shared"],
      ["slack-user", "personal"],
    ] as const) {
      await c.definitions.create("test", {
        id,
        displayName: id,
        type: "slack",
        ownership,
        presetOptions: { tokenMode: ownership === "shared" ? "bot" : "user" },
        audience: [alpha],
      });
      const link = await c.connections.createSecretLink(opPrincipal, id, "signingSecret");
      await c.connections.submitSecret(
        new URL(link.url).pathname.split("/").at(-1) as string,
        opSession,
        SECRET,
      );
    }
    a = (await appSignIn(h, (await tableauSignIn(h, tableau, alice)).cookie)).principal;
    carolPrincipal = (await appSignIn(h, (await tableauSignIn(h, tableau, carol)).cookie))
      .principal;
  });

  test("V24 with events off no Redis module is loaded and no client is created", async () => {
    const script = `
      import { registerHooks } from "node:module";
      const seen = [];
      registerHooks({ resolve(specifier, context, next) { if (specifier === "redis" || specifier.endsWith("/redis.ts")) seen.push(specifier); return next(specifier, context); } });
      const { createEvents } = await import(${JSON.stringify(new URL("../src/events/index.ts", import.meta.url).href)});
      const off = await createEvents({ redisUrl: process.argv[1] || undefined, connections: {}, clock: { now: () => new Date() }, log: { child() { return this; } }, sessionValid: async () => true });
      process.stdout.write(JSON.stringify({ created: off !== undefined, seen }));
    `;
    const run = (url: string) =>
      JSON.parse(
        execFileSync(process.execPath, ["--input-type=module", "-e", script, url], {
          encoding: "utf8",
        }),
      );
    assert.deepEqual(run(""), { created: false, seen: [] });
    const on = run("redis://127.0.0.1:1");
    assert.equal(on.created, true);
    assert.ok(on.seen.length > 0);
    assert.equal(
      await createEvents({
        redisUrl: undefined,
        connections: c.connections,
        clock: h.clock,
        log: new Log(() => {}),
        sessionValid: async () => true,
      }),
      undefined,
    );
  });

  test("an event fans out across replicas to every subscribed stream whose site is in the audience", async () => {
    const receiving = await replica();
    const other = await replica();
    await until(() => receiving.service.ready && other.service.ready, "redis");
    const aliceBot = new Sink();
    const aliceUser = new Sink();
    await other.service.open(a, ["slack-bot"], aliceBot);
    await other.service.open(a, ["slack-user"], aliceUser);
    assert.equal(
      await code(other.service.open(carolPrincipal, ["slack-bot"], new Sink())),
      "not-in-audience",
    );
    assert.equal(
      await code(other.service.open(a, ["missing"], new Sink())),
      "definition-not-found",
    );
    assert.deepEqual(aliceBot.frames(), [
      { event: "possible-loss", data: { reason: "stream-start" } },
    ]);

    for (const id of ["slack-bot", "slack-user"]) {
      const ingest = await receiving.service.ingest(id, signedDelivery(message(`Ev-${id}`)));
      assert.equal(ingest.response.status, 200);
      await ingest.publish();
    }
    await until(
      () => aliceBot.frames().length === 2 && aliceUser.frames().length === 2,
      "delivery",
    );
    const delivered = aliceBot.frames()[1]?.data as Record<string, unknown>;
    assert.equal(delivered.id, "Ev-slack-bot");
    assert.equal(delivered.definitionId, "slack-bot");
    assert.equal(delivered.type, "message");
    assert.equal(delivered.account, "T1");
    assert.equal(
      (aliceUser.frames()[1]?.data as Record<string, unknown>).definitionId,
      "slack-user",
    );

    // Narrowing the audience stops delivery to streams already open.
    const beta = (await listSites(db)).find((s) => s.contentUrl === "beta")?.id as string;
    await c.definitions.patch("test", "slack-bot", { audience: [beta] });
    await (
      await receiving.service.ingest("slack-bot", signedDelivery(message("Ev-after")))
    ).publish();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(aliceBot.frames().length, 2);
  });

  test("V25 forged or stale deliveries are refused before fan-out, and URL verification is answered", async () => {
    const r = await replica();
    await until(() => r.service.ready, "redis");
    const forged = signedDelivery(message("Ev-x"));
    forged.headers["x-slack-signature"] = `v0=${"0".repeat(64)}`;
    assert.equal(await code(r.service.ingest("slack-bot", forged)), "event-signature-invalid");
    const challenge = await r.service.ingest(
      "slack-bot",
      signedDelivery({ type: "url_verification", challenge: "c-1" }),
    );
    assert.deepEqual(challenge.response, { status: 200, contentType: "text/plain", body: "c-1" });
  });

  test("a slow client's buffer is bounded and it is told about loss", async () => {
    const r = await replica();
    await until(() => r.service.ready, "redis");
    const sink = new Sink();
    await r.service.open(a, ["slack-bot"], sink);
    sink.full = true;
    sink.write(": block\n\n");
    for (let i = 0; i < STREAM_BUFFER + 10; i++)
      await (await r.service.ingest("slack-bot", signedDelivery(message(`Ev${i}`)))).publish();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = sink.frames().length;
    sink.drain();
    const after = sink.frames().slice(before);
    assert.deepEqual(after[0], { event: "possible-loss", data: { reason: "slow-client" } });
    const ids = after.slice(1).map((f) => f.data.id);
    assert.equal(ids.length, STREAM_BUFFER);
    assert.equal(ids[0], "Ev10");
  });

  test("V24 with Redis down only events stop, streams report loss, and fan-out resumes", async () => {
    const port = await freePort();
    let server: ChildProcess | undefined;
    const startRedis = async () => {
      server = spawn(
        process.env.TDAS_TEST_REDIS_BIN as string,
        ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"],
        { stdio: "ignore" },
      );
      await new Promise((r) => setTimeout(r, 300));
    };
    try {
      // Starting with Redis unreachable does not fail.
      const r = await replica(`redis://127.0.0.1:${port}`);
      assert.equal(r.service.ready, false);
      const sink = new Sink();
      await r.service.open(a, ["slack-bot"], sink);
      assert.deepEqual(
        sink.frames().map((f) => f.data.reason),
        ["stream-start", "fan-out-unavailable"],
      );
      // Ingest still verifies and acknowledges; publishing fails quietly.
      const acked = await r.service.ingest("slack-bot", signedDelivery(message("Ev-down")));
      assert.equal(acked.response.status, 200);
      await acked.publish();
      assert.ok(r.lines.some((l) => l.includes("event not published")));

      await startRedis();
      await until(() => r.service.ready, "redis up", 10_000);
      await until(
        () => sink.frames().some((f) => f.data.reason === "fan-out-reconnected"),
        "reconnect loss",
      );
      await (await r.service.ingest("slack-bot", signedDelivery(message("Ev-up")))).publish();
      await until(
        () => sink.frames().some((f) => f.data.id === "Ev-up"),
        "delivery after reconnect",
      );

      server?.kill("SIGKILL");
      await until(() => !r.service.ready, "redis down", 10_000);
      const unavailable = () =>
        sink.frames().filter((f) => f.data.reason === "fan-out-unavailable").length;
      await until(() => unavailable() === 2, "down loss");
    } finally {
      server?.kill("SIGKILL");
    }
  });

  test("a stream still opening when shutdown begins is refused, not left open", async () => {
    const r = await replica();
    await until(() => r.service.ready, "redis");
    const current = c.definitions.current.bind(c.definitions);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let loading!: () => void;
    const loaded = new Promise<void>((resolve) => {
      loading = resolve;
    });
    c.definitions.current = async (...args: Parameters<typeof current>) => {
      loading();
      await gate;
      return await current(...args);
    };
    try {
      const opening = code(r.service.open(a, ["slack-bot"], new Sink()));
      await loaded;
      r.service.closeStreams();
      release();
      assert.equal(await opening, "service-stopping");
      assert.equal(r.service.streamCount, 0);
    } finally {
      c.definitions.current = current;
    }
  });

  test("streams close when the session ends", async () => {
    const lines: string[] = [];
    let valid = true;
    const service = new EventService({
      bus: new RedisEventBus({
        url: process.env.TDAS_TEST_REDIS as string,
        log: new Log((l) => lines.push(l)),
      }),
      connections: c.connections,
      clock: h.clock,
      log: new Log((l) => lines.push(l)),
      sessionValid: async () => valid,
    });
    await service.start();
    services.push(service);
    await until(() => service.ready, "redis");
    const sink = new Sink();
    await service.open(a, ["slack-bot"], sink);
    valid = false;
    await service.recheck();
    assert.equal(sink.ended, true);
    assert.equal(service.streamCount, 0);
    assert.ok(sink.frames().some((f) => f.event === "end" && f.data.reason === "session-ended"));
  });
});

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ServiceError, String(error));
    return error.code;
  }
  assert.fail("expected a ServiceError");
}
