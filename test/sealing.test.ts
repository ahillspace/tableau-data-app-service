import assert from "node:assert/strict";
import test from "node:test";
import { definitionSecretRecordId, reseal } from "../src/sealing/reseal.ts";
import { Sealer } from "../src/sealing/sealer.ts";
import { freshDatabase, testKeys } from "./support/db.ts";

test("V9: a sealed value opens only with the same purpose and record ID", () => {
  const sealer = new Sealer(testKeys("k1"));
  const sealed = sealer.seal("credential", "conn-1", "token-value");
  assert.equal(sealer.open("credential", "conn-1", sealed), "token-value");
  assert.throws(() => sealer.open("credential", "conn-2", sealed), {
    code: "credential-unavailable",
  });
  assert.throws(() => sealer.open("client-secret", "conn-1", sealed), {
    code: "credential-unavailable",
  });
  assert.throws(
    () => sealer.open("credential", "conn-1", { ...sealed, keyId: "k9" }),
    (error: Error) => error.message.includes("k9") && !error.message.includes("token-value"),
  );
  const tampered = { ...sealed, ciphertext: Buffer.from("x").toString("base64url") };
  assert.throws(() => sealer.open("credential", "conn-1", tampered), {
    code: "credential-unavailable",
  });
});

test("V9: the key ID is bound, so relabelling a value with another key fails", () => {
  const keys = testKeys("k1", "k2");
  const sealer = new Sealer(keys);
  const sealed = sealer.seal("credential", "c", "v");
  assert.equal(sealed.keyId, "k2");
  assert.throws(() => sealer.open("credential", "c", { ...sealed, keyId: "k1" }));
});

test("reseal replaces old-key values online and is rerunnable", async () => {
  const { db, close } = await freshDatabase();
  try {
    const oldKeys = testKeys("old");
    const oldSealer = new Sealer(oldKeys);
    const both = { current: "new", keys: new Map([...oldKeys.keys, ["new", Buffer.alloc(32, 7)]]) };
    const sealer = new Sealer(both);
    await db
      .insertInto("definitions")
      .values({
        id: "d1",
        display_name: "D",
        ownership: "shared",
        configuration: JSON.stringify({
          id: "d1",
          displayName: "D",
          ownership: "shared",
          authentication: { method: "static" },
          apiHosts: ["https://example.com"],
          scopes: [],
          audience: [],
          credentialPlacement: { kind: "bearer" },
          enabled: true,
          privateHosts: false,
        }),
        audience: "[]",
        enabled: true,
        updated_at: new Date(),
        retired_at: null,
      })
      .execute();
    await db
      .insertInto("definition_secrets")
      .values({
        definition_id: "d1",
        field: "clientSecret",
        sealed: JSON.stringify(
          oldSealer.seal("client-secret", definitionSecretRecordId("d1", "clientSecret"), "cs"),
        ),
        set_at: new Date(),
      })
      .execute();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const row = await db
        .insertInto("connections")
        .values({
          definition_id: "d1",
          generation: 1,
          owner_identity_id: null,
          status: "disconnected",
          sealed: null,
          account: null,
          scopes: "[]",
          authorized_at: new Date(),
          credential_expires_at: null,
          disconnected_at: null,
          disconnect_reason: null,
          updated_at: new Date(),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      ids.push(row.id);
    }
    // One live connection sealed with the old key.
    const live = ids[0] as string;
    await db
      .updateTable("connections")
      .set({
        status: "connected",
        sealed: JSON.stringify(oldSealer.seal("credential", live, "tok")),
      })
      .where("id", "=", live)
      .execute();
    const report = await reseal(db, sealer);
    assert.equal(report.remaining, 0);
    assert.equal(report.resealed, 2);
    const conn = await db
      .selectFrom("connections")
      .select("sealed")
      .where("id", "=", live)
      .executeTakeFirstOrThrow();
    assert.equal(conn.sealed?.keyId, "new");
    assert.equal(sealer.open("credential", live, conn.sealed as never), "tok");
    assert.deepEqual(await reseal(db, sealer), { resealed: 0, remaining: 0 });
  } finally {
    await close();
  }
});
