import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { type TestContext, test } from "node:test";
import { type KyselyPlugin, sql } from "kysely";
import { DefinitionStore } from "../src/connections/definitions.ts";
import { ConnectionService } from "../src/connections/service.ts";
import type { Authentication, Webhook } from "../src/contracts/operator.ts";
import { EventService } from "../src/events/service.ts";
import type { EventBus, ServiceEvent } from "../src/events/types.ts";
import type { Db } from "../src/persistence/database.ts";
import { ServiceError } from "../src/platform/errors.ts";
import { Log } from "../src/platform/log.ts";
import {
  deferred,
  type IntakeHarness,
  IntakeProvider,
  intakeHarness,
  signingKey,
  tokenResponse,
  verifyJwt,
} from "./support/intake-providers.ts";

async function fixture(t: TestContext) {
  const provider = await new IntakeProvider().start();
  const h = await intakeHarness(provider);
  t.after(async () => {
    await h.close();
    await provider.close();
  });
  return { provider, h };
}

function pauseDefinitionRead(db: Db) {
  const read = deferred();
  const release = deferred();
  let queryId: object | undefined;
  const plugin: KyselyPlugin = {
    transformQuery(args) {
      if (
        !queryId &&
        args.node.kind === "SelectQueryNode" &&
        JSON.stringify(args.node).includes('"definitions"')
      )
        queryId = args.queryId;
      return args.node;
    },
    async transformResult(args) {
      if (args.queryId === queryId) {
        read.resolve();
        await release.promise;
      }
      return args.result;
    },
  };
  return { db: db.withPlugin(plugin), read, release };
}

async function interleaveRedefinition(
  db: Db,
  gate: ReturnType<typeof pauseDefinitionRead>,
  mutation: Promise<Response>,
) {
  let settled = false;
  void mutation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    const deadline = Date.now() + 5000;
    while (!settled) {
      const waiting = await sql<{ blocked: boolean }>`select exists (
        select 1 from pg_stat_activity where datname = current_database()
          and wait_event_type = 'Lock' and query like '%"definitions"%for update%'
      ) as blocked`.execute(db);
      if (waiting.rows[0]?.blocked) break;
      assert.ok(Date.now() < deadline, "redefinition commits or waits on captured authority");
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    gate.release.resolve();
  }
  const response = await mutation;
  assert.equal(response.status, 200, await response.clone().text());
}

function snapshotService(t: TestContext, h: IntakeHarness, provider: IntakeProvider, db: Db) {
  const outbound = provider.outbound();
  t.after(() => outbound.close());
  const definitions = new DefinitionStore({
    db,
    extensions: h.definitions.extensions,
    sealer: h.sealer,
    clock: h.identity.clock,
  });
  return new ConnectionService({
    db,
    definitions,
    sealer: h.sealer,
    outbound,
    publicOrigin: "https://service.test",
    clock: h.identity.clock,
    log: new Log(() => {}),
  });
}

for (const method of ["client_secret_post", "private_key_jwt"] as const) {
  test(`OAuth callback pairs ${method} application authority with its captured token endpoint`, {
    timeout: 20_000,
  }, async (t) => {
    const { provider, h } = await fixture(t);
    const oldKey = signingKey();
    const newKey = signingKey();
    const oldSecret = "synthetic-old-application-secret";
    const newSecret = "synthetic-new-application-secret";
    const authentication = (
      path: string,
    ): Extract<Authentication, { method: "authorization_code" }> => ({
      method: "authorization_code",
      authorizationEndpoint: `${provider.origin}/authorize`,
      tokenEndpoint: `${provider.origin}${path}`,
      clientAuthentication:
        method === "private_key_jwt"
          ? {
              method,
              clientId: "snapshot-client",
              jwt: {
                algorithm: "RS256",
                issuer: "snapshot-client",
                subject: "snapshot-client",
                audience: `${provider.origin}${path}`,
                keyId: "application-key",
                ttlSeconds: 300,
              },
            }
          : { method, clientId: "snapshot-client" },
      pkce: "S256",
      scopeParameter: { name: "scope", separator: " " },
      response: tokenResponse,
    });
    const definition = h.definition("oauth-snapshot", {
      authentication: authentication("/old-token"),
      secrets:
        method === "private_key_jwt"
          ? { signingPrivateKey: oldKey.privateKey }
          : { clientSecret: oldSecret },
    });
    const original = await h.create(definition);
    const started = await h.connections.startConnect(h.operator.principal, original.id, "shared");
    assert.equal(started.kind, "redirect");
    const session = await h.identity.identity.readSignInSession(h.cookie.split("=")[1]);
    assert.ok(session);
    const authorize = await h.connections.beginConnect(started.transactionId, session);
    const gate = pauseDefinitionRead(h.db);
    const service = snapshotService(t, h, provider, gate.db);
    const entered = deferred();
    const finish = deferred();
    provider.expect(
      "/old-token",
      (request) => {
        entered.resolve();
        assert.equal(request.form.get("grant_type"), "authorization_code");
        if (method === "client_secret_post") {
          assert.equal(request.form.get("client_secret"), oldSecret);
        } else {
          verifyJwt(request.form.get("client_assertion") as string, {
            key: oldKey.publicKey,
            algorithm: "RS256",
            keyId: "application-key",
            issuer: "snapshot-client",
            subject: "snapshot-client",
            audience: `${provider.origin}/old-token`,
            ttl: 300,
            jti: true,
          });
        }
      },
      { wait: finish.promise, json: { access_token: "synthetic-old-access", expires_in: 3600 } },
    );
    const callback = service
      .completeConnect({
        session,
        query: new URLSearchParams({
          state: authorize.searchParams.get("state")!,
          code: "snapshot-code",
        }),
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await gate.read.promise;
    try {
      await interleaveRedefinition(
        h.db,
        gate,
        h.request(`/v1/admin/definitions/${original.id}`, {
          method: "PUT",
          json: {
            ...definition,
            expectedVersion: original.version,
            authentication: authentication("/new-token"),
            secrets:
              method === "private_key_jwt"
                ? { signingPrivateKey: newKey.privateKey }
                : { clientSecret: newSecret },
          },
        }),
      );
      await entered.promise;
    } finally {
      gate.release.resolve();
      finish.resolve();
    }
    const error = await callback;
    assert.ok(error instanceof ServiceError);
    assert.equal(error.code, "definition-changed");
    assert.equal(provider.count("/new-token"), 0);
    assert.equal(provider.count("/old-token"), 1);
    assert.equal((await h.connections.listConnections({ definitionId: original.id })).length, 0);
    const restarted = await h.connections.startConnect(h.operator.principal, original.id, "shared");
    assert.equal(restarted.kind, "redirect");
    const currentAuthorize = await h.connections.beginConnect(restarted.transactionId, session);
    provider.expect(
      "/new-token",
      (request) => {
        if (method === "client_secret_post") {
          assert.equal(request.form.get("client_secret"), newSecret);
        } else {
          verifyJwt(request.form.get("client_assertion") as string, {
            key: newKey.publicKey,
            algorithm: "RS256",
            keyId: "application-key",
            issuer: "snapshot-client",
            subject: "snapshot-client",
            audience: `${provider.origin}/new-token`,
            ttl: 300,
            jti: true,
          });
        }
      },
      { json: { access_token: "synthetic-new-access", expires_in: 3600 } },
    );
    await h.connections.completeConnect({
      session,
      query: new URLSearchParams({
        state: currentAuthorize.searchParams.get("state")!,
        code: "current-code",
      }),
    });
    provider.expect("/native", (request) => {
      assert.equal(request.headers.authorization, "Bearer synthetic-new-access");
    });
    assert.equal((await h.native(original.id)).status, 200);
    provider.assertComplete();
    await h.assertSafe([
      oldSecret,
      newSecret,
      oldKey.privateKey,
      newKey.privateKey,
      "synthetic-new-access",
    ]);
  });
}

const webhook = (version: "old" | "new"): Webhook => ({
  verification: {
    kind: "hmac",
    algorithm: "sha256",
    header: `x-${version}-signature`,
    prefix: `${version}=`,
    encoding: "hex",
    parts: [{ rawBody: true }],
  },
  handshake: {
    kind: "verified-json-echo",
    when: { path: ["kind"], equals: "challenge" },
    value: [`${version}Challenge`],
    response: "json",
    responseKey: version,
  },
  event: {
    id: { json: ["id"] },
    type: { literal: `${version}-event` },
    account: [{ literal: `${version}-account` }],
    payload: [`${version}Payload`],
  },
});

for (const deliveryKind of ["event", "handshake", "hybrid"] as const) {
  test(`webhook ${deliveryKind} uses one captured verifier, handshake, event mapping and signing secret`, {
    timeout: 20_000,
  }, async (t) => {
    const { provider, h } = await fixture(t);
    const oldSecret = "synthetic-old-verification-secret";
    const newSecret = "synthetic-new-verification-secret";
    const definition = h.definition("webhook-snapshot", {
      webhook: webhook("old"),
      secrets: { signingSecret: oldSecret },
    });
    const original = await h.create(definition);
    const gate = pauseDefinitionRead(h.db);
    const connections = snapshotService(t, h, provider, gate.db);
    const published: ServiceEvent[] = [];
    const bus: EventBus = {
      ready: true,
      async start() {},
      async close() {},
      async publish(event) {
        published.push(event);
      },
    };
    const events = new EventService({
      bus,
      connections,
      clock: h.identity.clock,
      log: new Log(() => {}),
      sessionValid: async () => true,
    });
    const body = Buffer.from(
      JSON.stringify({
        id: "snapshot-event",
        kind: deliveryKind === "handshake" ? "challenge" : "event",
        oldChallenge: "captured-challenge",
        newChallenge: "replacement-challenge",
        oldPayload: { captured: true },
        newPayload: { replacement: true },
      }),
    );
    const signature = createHmac("sha256", deliveryKind === "hybrid" ? newSecret : oldSecret)
      .update(body)
      .digest("hex");
    const ingestion = events
      .ingest(original.id, {
        body,
        headers: { "x-old-signature": `old=${signature}` },
      })
      .then(
        (outcome) => ({ outcome }),
        (error: unknown) => ({ error }),
      );
    await gate.read.promise;
    await interleaveRedefinition(
      h.db,
      gate,
      h.request(`/v1/admin/definitions/${original.id}`, {
        method: "PUT",
        json: {
          ...definition,
          expectedVersion: original.version,
          webhook: webhook("new"),
          secrets: { signingSecret: newSecret },
        },
      }),
    );
    const result = await ingestion;
    if (deliveryKind === "hybrid") {
      assert.ok("error" in result);
      assert.ok(result.error instanceof ServiceError);
      assert.equal(result.error.code, "event-signature-invalid");
      assert.equal(published.length, 0);
    } else {
      assert.ok("outcome" in result);
      assert.equal(result.outcome.response.status, 200);
      await result.outcome.publish();
      if (deliveryKind === "handshake") {
        assert.equal(result.outcome.response.body, '{"old":"captured-challenge"}');
        assert.equal(published.length, 0);
      } else {
        assert.equal(published.length, 1);
        assert.equal(published[0]!.type, "old-event");
        assert.equal(published[0]!.account, "old-account");
        assert.deepEqual(published[0]!.payload, { captured: true });
      }
    }
    provider.assertComplete();
  });
}
