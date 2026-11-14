import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "kysely";
import { CoreMaintenance } from "../src/connections/maintenance.js";
import { Renewals } from "../src/connections/renewals.js";
import { ConnectionService } from "../src/connections/service.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { candidate, coreFixture, fixtureProvider } from "./core-fixture.js";

test("core recovery fences an expired invalidating processor and releases only undispatched reservations", async () => {
  const f = await coreFixture();
  try {
    const rows = await Promise.all(
      [candidate("a"), candidate("b")].map((value) =>
        f.credentials.publishLocal(f.alice.access, fixtureProvider, value),
      ),
    );
    const refs = await Promise.all(
      rows.map((row) =>
        f.credentials.reserve(f.alice.access, "fixture", "renewal", new Date(Date.now() + 30000), {
          connectionId: row.id,
          expectedAuthorityGeneration: 1,
        }),
      ),
    );
    const claim = await f.credentials.claim(
      f.alice.access,
      "fixture",
      refs[0]!,
      "old-process",
      10000,
    );
    await f.credentials.dispatch(f.alice.access, "fixture", refs[0]!, claim, true);
    await f.db
      .updateTable("credential_mutations")
      .set({ lease_until: sql`clock_timestamp()-interval '1 second'` })
      .where("id", "=", refs[0]!.id)
      .execute();
    await f.db
      .updateTable("credential_mutations")
      .set({ expires_at: sql`clock_timestamp()-interval '1 second'` })
      .where("id", "=", refs[1]!.id)
      .execute();
    await new CoreMaintenance(f.db, f.credentials, 10).run(new AbortController().signal);
    const current = await f.db
      .selectFrom("connections")
      .selectAll()
      .where(
        "id",
        "in",
        rows.map((row) => row.id),
      )
      .execute();
    assert.equal(current.find((row) => row.id === rows[0]!.id)?.state, "renewal-uncertain");
    assert.equal(current.find((row) => row.id === rows[1]!.id)?.mutation_id, null);
    await assert.rejects(
      f.credentials.publish(f.alice.access, fixtureProvider, refs[0]!, claim, {
        ...candidate("late"),
        verifiedReauthorization: false,
      }),
      { code: "stale-mutation" },
    );
  } finally {
    await f.close();
  }
});

test("concurrent expired checkouts rotate once across services, preserve deliberate reauth and fence provider results after disconnect", async () => {
  const f = await coreFixture();
  let calls = 0,
    held = false;
  let contacted: () => void = () => {},
    release: () => void = () => {};
  let gate = Promise.resolve();
  const provider = {
    ...fixtureProvider,
    renewal: {
      mayInvalidate: true,
      async renew() {
        calls++;
        contacted();
        if (held) await gate;
        return {
          ...candidate(`token-${calls}`),
          verifiedReauthorization: false,
          expiresAt: new Date(Date.now() + 60000),
        };
      },
    },
  };
  const registry = new ProviderRegistry([provider]);
  const create = () => {
    const connections = new ConnectionService(f.db, f.access, f.secrets, registry, {
      maxSockets: 4,
      connectTimeoutMs: 1000,
      headersTimeoutMs: 5000,
      stallTimeoutMs: 1000,
    });
    const renewal = new Renewals(connections, f.credentials, {
      operationMs: 5000,
      leaseMs: 5000,
      contentionMs: 5,
    });
    connections.installRenewal((...args) => renewal.renew(...args));
    return connections;
  };
  const first = create(),
    second = create();
  try {
    const original = await f.credentials.publishLocal(f.alice.access, provider, {
      ...candidate(),
      expiresAt: new Date(Date.now() - 1000),
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        (i % 2 ? first : second).prepare(f.alice.token, "one", "fixture", original.id),
      ),
    );
    assert.equal(calls, 1);
    for (const result of results)
      assert.deepEqual(result.take()?.credentials, { token: "token-1" });
    const row = await f.db
      .selectFrom("connections")
      .selectAll()
      .where("id", "=", original.id)
      .executeTakeFirstOrThrow();
    assert.equal(row.authority_generation, 1);
    assert.equal(row.credential_generation, 2);
    assert.equal(
      row.last_connector_reauth_at?.getTime(),
      original.last_connector_reauth_at?.getTime(),
    );
    await f.db
      .updateTable("connections")
      .set({ credential_expires_at: sql`clock_timestamp()-interval '1 second'` })
      .where("id", "=", row.id)
      .execute();
    held = true;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      contacted = resolve;
    });
    const pending = first.prepare(f.alice.token, "one", "fixture", original.id);
    await ready;
    await first.disconnect(f.alice.access, row.id, 1);
    release();
    await assert.rejects(pending);
    const final = await f.db
      .selectFrom("connections")
      .selectAll()
      .where("id", "=", row.id)
      .executeTakeFirstOrThrow();
    assert.equal(final.state, "disconnected");
    assert.equal(final.bundle, null);
    assert.equal(final.credential_generation, 2);
    assert.equal(calls, 2);
  } finally {
    release();
    await f.close();
  }
});
