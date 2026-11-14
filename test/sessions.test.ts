import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "kysely";
import type { IdentityAdapter } from "../src/access/adapters.js";
import { cookieValue, SessionService } from "../src/access/sessions.js";
import { createHttpApp } from "../src/http/app.js";
import { registerSessionRoutes } from "../src/http/session-routes.js";
import { randomSecret, verifier } from "../src/security/secrets.js";
import { coreFixture } from "./core-fixture.js";

test("two replicas exchange and redeem one handoff exactly once; restoration preserves owner and fixed verified time after access expiry", async () => {
  const f = await coreFixture();
  let exchanges = 0;
  const adapter: IdentityAdapter = {
    id: "fixture",
    deploymentId: "cloud",
    callbackUri: "https://service.example/callback",
    async begin() {
      return {
        authorizationUrl: "https://fixture.example/authorize",
        protectedState: {
          state: randomSecret(),
          verifier: randomSecret(),
          nonce: randomSecret(),
          clientId: "fixture",
          deviceId: "device",
        },
      };
    },
    async complete() {
      exchanges++;
      return {
        deploymentId: "cloud",
        siteId: "site",
        subjectId: "alice",
        adapterId: "fixture",
        verifiedAt: new Date(Date.now() - 100),
      };
    },
  };
  const one = new SessionService(f.db, f.access, f.secrets, new Map([["cloud", adapter]]), 30000);
  const two = new SessionService(f.db, f.access, f.secrets, new Map([["cloud", adapter]]), 30000);
  try {
    const proof = randomSecret();
    const transaction = await one.begin("one", "cloud", verifier(proof));
    await assert.rejects(one.launch(transaction.id, randomSecret()), {
      status: 401,
    });
    const launch = await one.launch(transaction.id, proof);
    const state = await f.db
      .selectFrom("session_transactions")
      .select("protected_state")
      .where("id", "=", transaction.id)
      .executeTakeFirstOrThrow();
    const bytes = f.secrets.open(state.protected_state, {
      kind: "session-transaction",
      id: transaction.id,
      provider: "fixture",
      revision: "1",
    });
    const callback = new URLSearchParams({
      state: (JSON.parse(bytes.toString()) as { state: string }).state,
      code: "one-use-code",
    });
    bytes.fill(0);
    await assert.rejects(
      two.callback("fixture", callback, randomSecret(), new AbortController().signal),
      { status: 401 },
    );
    const callbacks = await Promise.allSettled(
      [one, two].map((service) =>
        service.callback("fixture", callback, launch.browserSecret, new AbortController().signal),
      ),
    );
    assert.equal(callbacks.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(exchanges, 1);
    const redemptions = await Promise.allSettled(
      [one, two].map((service) => service.redeem(transaction.id, proof)),
    );
    const success = redemptions.find((result) => result.status === "fulfilled");
    assert.ok(success?.status === "fulfilled");
    assert.equal(redemptions.filter((result) => result.status === "fulfilled").length, 1);
    const issued = success.value;
    const secret = cookieValue(issued.cookie, issued.cookie.split("=")[0] ?? "");
    assert.ok(secret);
    const access = await f.access.authenticate(issued.response.accessToken, "two");
    assert.equal(access.ownerId, f.alice.access.ownerId);
    const before = await f.db
      .selectFrom("sessions")
      .selectAll()
      .where("id", "=", access.sessionId)
      .executeTakeFirstOrThrow();
    await f.db
      .updateTable("access_tokens")
      .set({ expires_at: sql`clock_timestamp()-interval '1 second'` })
      .where("verifier", "=", verifier(issued.response.accessToken))
      .execute();
    await assert.rejects(f.access.authenticate(issued.response.accessToken, "two"), {
      status: 401,
    });
    const restored = await two.restore("two", "cloud", secret);
    assert.notEqual(restored.accessToken, issued.response.accessToken);
    assert.deepEqual(restored.identity, issued.response.identity);
    assert.equal(restored.authenticationExpiresAt, issued.response.authenticationExpiresAt);
    const after = await f.db
      .selectFrom("sessions")
      .selectAll()
      .where("id", "=", access.sessionId)
      .executeTakeFirstOrThrow();
    assert.deepEqual(after.verified_at, before.verified_at);
    assert.deepEqual(after.authentication_expires_at, before.authentication_expires_at);
    await assert.rejects(two.restore("two", "other-deployment", secret), { status: 401 });
    await f.db
      .updateTable("tableau_sites")
      .set({ enabled: false })
      .where("id", "=", "site-row")
      .execute();
    await assert.rejects(two.restore("two", "cloud", secret), { status: 403 });
    await f.db
      .updateTable("tableau_sites")
      .set({ enabled: true })
      .where("id", "=", "site-row")
      .execute();
    await f.db
      .updateTable("sessions")
      .set({ authentication_expires_at: sql`clock_timestamp()` })
      .where("id", "=", access.sessionId)
      .execute();
    await assert.rejects(two.restore("two", "cloud", secret), { status: 401 });
  } finally {
    await f.close();
  }
});

test("accepted login creates only an inert transaction; a locator or wrong proof cannot launch OAuth", async () => {
  const f = await coreFixture();
  let invoked = false;
  const adapter: IdentityAdapter = {
    id: "fixture",
    deploymentId: "cloud",
    callbackUri: "https://service.example/callback",
    async begin() {
      invoked = true;
      throw new Error("Must not launch");
    },
    async complete() {
      throw new Error("Must not complete");
    },
  };
  const sessions = new SessionService(
    f.db,
    f.access,
    f.secrets,
    new Map([["cloud", adapter]]),
    30000,
  );
  const app = await createHttpApp({ db: f.db });
  registerSessionRoutes(app, sessions, "https://service.example");
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/session/transactions",
      headers: {
        origin: "null",
        cookie: "attacker-binding=known",
        "x-parent-origin": "https://trusted-tableau.example",
      },
      payload: {
        appId: "one",
        deploymentId: "cloud",
        initiationVerifier: verifier(randomSecret()),
      },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(invoked, false);
    assert.equal((await f.db.selectFrom("session_transactions").select("id").execute()).length, 1);
    const inert = await app.inject(`/v1/session/transactions/${response.json().id}/launch`);
    assert.equal(inert.statusCode, 200);
    assert.equal(invoked, false);
    const forged = await app.inject({
      method: "POST",
      url: `/v1/session/transactions/${response.json().id}/launch`,
      payload: { initiationProof: randomSecret() },
    });
    assert.equal(forged.statusCode, 401);
    assert.equal(invoked, false);
    assert.equal((await app.inject("/v1/session/transactions/attacker/helper")).statusCode, 404);
  } finally {
    await app.close();
    await f.close();
  }
});
