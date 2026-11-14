import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "kysely";
import { ConnectionService } from "../src/connections/service.js";
import type { CoreServices } from "../src/core-ports.js";
import { SourceMaintenance } from "../src/events/lifecycle.js";
import { Sources } from "../src/events/sources.js";
import type { EventProvider, SourcePublication } from "../src/events/types.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { candidate, coreFixture, fixtureProvider } from "./core-fixture.js";

async function fixture(
  hooks: EventProvider["hooks"],
  publication: Partial<SourcePublication> = {},
) {
  const f = await coreFixture();
  const connections = new ConnectionService(
    f.db,
    f.access,
    f.secrets,
    new ProviderRegistry([fixtureProvider]),
    { connectTimeoutMs: 1000, headersTimeoutMs: 1000, stallTimeoutMs: 1000, maxSockets: 8 },
  );
  const core: CoreServices = {
    db: f.db,
    controlDb: f.db,
    secrets: f.secrets,
    access: f.access,
    connections,
  };
  const provider: EventProvider = {
    verify: async () => {
      throw new Error("Not used in source lifecycle fixture");
    },
    verifyAssociation: async (_input, context) =>
      context.withCredentials(async () => ({
        accountKey: "original-account",
        privateContext: { verifier: "source-private" },
        ...publication,
      })),
    eventValid: (_source, event, now) => event.validUntil > now,
    forwardingUnavailable: { status: 503 },
    ...(hooks ? { hooks } : {}),
  };
  const sources = new Sources(core, new Map([["fixture", provider]]));
  connections.registerAuthority("event-source", sources.backgroundAuthority());
  const connection = await f.credentials.publishLocal(f.alice.access, fixtureProvider, candidate());
  const maintenance = new SourceMaintenance(sources, {
    incarnation: "test-worker",
    leaseMs: 3000,
    cleanupMs: 100,
    requestTermination: (reason) => {
      throw new Error(`Unexpected worker termination: ${reason}`);
    },
  });
  return {
    ...f,
    sources,
    maintenance,
    connection,
    create: () =>
      sources.associate(f.alice.access, {
        providerRegistrationId: "fixture",
        connectionId: connection.id,
        setup: "service",
        inputs: {},
      }),
  };
}

test("service source creation uses M09 and its own claim; retirement fences a delayed hook result and never replays its dispatch", async () => {
  let dispatched!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let creates = 0;
  const f = await fixture({
    create: async ({ markMayHaveDispatched }) => {
      await markMayHaveDispatched();
      creates++;
      dispatched();
      await gate;
      return { accountKey: "original-account", privateContext: { verifier: "new-source-private" } };
    },
  });
  try {
    const id = await f.create();
    assert.equal(await f.sources.eligible(id), undefined);
    const running = f.maintenance.run(new AbortController().signal);
    await started;
    await f.sources.retire(f.alice.access, id);
    release();
    await running;
    const source = await f.sources.get(id);
    assert.equal(source!.state, "retired");
    assert.deepEqual(f.sources.context(source!), {});
    await f.maintenance.run(new AbortController().signal);
    assert.equal(creates, 1);
  } finally {
    release();
    await f.close();
  }
});

test("source claim rejects publication when its lease expires during an actual row-lock wait", async () => {
  const f = await fixture(undefined);
  let release!: () => void, locked!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = new Promise<void>((resolve) => {
    locked = resolve;
  });
  let holder: Promise<void> | undefined;
  try {
    const id = await f.create();
    const before = await f.sources.db
      .updateTable("event_sources")
      .set({
        claim_token: "test-claim",
        claim_incarnation: "test-worker",
        operation: "renew",
        phase: "claimed",
        lease_until: sql`clock_timestamp() + interval '1 second'`,
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
    holder = f.sources.db.transaction().execute(async (tx) => {
      await tx.selectFrom("event_sources").select("id").where("id", "=", id).forUpdate().execute();
      locked();
      await gate;
    });
    await acquired;
    let pid = 0;
    const publication = f.sources.db.transaction().execute(async (tx) => {
      pid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(tx)).rows[0]!.pid;
      await f.sources.lockClaim(tx, {
        source: "event-source",
        sourceId: id,
        claim: { token: "test-claim", incarnation: "test-worker" },
      });
      await tx
        .updateTable("event_sources")
        .set({ revision: before.revision + 1 })
        .where("id", "=", id)
        .execute();
    });
    const deadline = Date.now() + 3000;
    while (true) {
      const wait = await sql<{
        waiting: boolean;
      }>`select exists(select 1 from pg_stat_activity where pid = ${pid} and wait_event_type = 'Lock') as waiting`.execute(
        f.db,
      );
      if (wait.rows[0]!.waiting) break;
      assert.ok(Date.now() < deadline, "Expected a real database row-lock wait");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(
      (
        await sql<{
          live: boolean;
        }>`select lease_until > clock_timestamp() as live from event_sources where id = ${id}`.execute(
          f.db,
        )
      ).rows[0]!.live,
      "Lease must still be live when the wait begins",
    );
    await sql`select pg_sleep(1.1)`.execute(f.db);
    release();
    await holder;
    await assert.rejects(publication, { code: "stale-source-claim" });
    assert.equal((await f.sources.get(id))!.revision, before.revision);
  } finally {
    release();
    await holder;
    await f.close();
  }
});

test("uncertain renewal remains observable without retry; configured retirement disables routing and erases saved verifier before its bounded remote hook", async () => {
  let renewals = 0,
    retirements = 0;
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(
    {
      renew: async ({ markMayHaveDispatched }) => {
        await markMayHaveDispatched();
        renewals++;
        throw new Error("Remote response lost after mutation");
      },
      retire: async ({ source, privateContext, provider, markMayHaveDispatched }) => {
        retirements++;
        assert.equal(await f.sources.eligible(source.id), undefined);
        assert.deepEqual(f.sources.context((await f.sources.get(source.id))!), {});
        assert.deepEqual(privateContext, { verifier: "source-private" });
        await provider.withCredentials(async () => {});
        await markMayHaveDispatched();
        return { accountKey: "original-account", privateContext: {} };
      },
    },
    { renewAfter: new Date(Date.now() - 1000) },
  );
  try {
    const id = await f.create();
    await f.maintenance.run(new AbortController().signal);
    const source = await f.sources.get(id);
    assert.equal(source!.state, "attention-required");
    assert.equal(source!.phase, "uncertain");
    assert.equal((await f.sources.eligible(id))!.id, id);
    await f.maintenance.run(new AbortController().signal);
    assert.equal(renewals, 1);
    await f.maintenance.retire(f.alice.access, id);
    await f.maintenance.retire(f.alice.access, id);
    assert.equal(retirements, 1);
    assert.equal((await f.sources.get(id))!.phase, null);
  } finally {
    await f.close();
  }
});
