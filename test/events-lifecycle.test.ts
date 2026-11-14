import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectionService } from "../src/connections/service.js";
import type { CoreServices } from "../src/core-ports.js";
import { up } from "../src/db/migrations/030_events.js";
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
  await up(f.db);
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
