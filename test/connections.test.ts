import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { sql } from "kysely";
import type { ProviderType } from "../src/connections/provider-types.ts";
import type { CredentialLease, OutgoingRequest } from "../src/connections/types.ts";
import {
  addOperator,
  addSite,
  listOperators,
  listSites,
  removeOperator,
  removeSite,
} from "../src/identity/directory.ts";
import type { Principal, SignInSession } from "../src/identity/types.ts";
import type { Db } from "../src/persistence/database.ts";
import { ServiceError } from "../src/platform/errors.ts";
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
import { OAuthStandIn } from "./support/oauth.ts";
import { TableauStandIn, type TableauUser } from "./support/tableau.ts";

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ServiceError, String(error));
    return error.code;
  }
  assert.fail("expected a ServiceError");
}

function fieldRules(error: unknown): Record<string, string> {
  assert.ok(error instanceof ServiceError, String(error));
  return Object.fromEntries((error.fields ?? []).map((f) => [f.path, f.rule]));
}

function applied(
  lease: { apply(r: OutgoingRequest): void },
  target = "/v1/thing",
): OutgoingRequest {
  const request: OutgoingRequest = { target, headers: [] };
  lease.apply(request);
  return request;
}

const alice: TableauUser = {
  siteId: "site-a",
  siteContentUrl: "alpha",
  userId: "user-a",
  userName: "alice@example.com",
};
const bob: TableauUser = {
  siteId: "site-a",
  siteContentUrl: "alpha",
  userId: "user-b",
  userName: "bob@example.com",
};
const operatorUser: TableauUser = {
  siteId: "site-a",
  siteContentUrl: "alpha",
  userId: "user-op",
  userName: "op@example.com",
};

type Person = { principal: Principal; session: SignInSession; cookie: string };

/** Revocations a test preset was asked for, with the API hosts of the definition it was given. */
const revoked: { connectionId: string | null; apiHosts: string[] }[] = [];
const revocable: ProviderType = {
  name: "revocable",
  oauth: "none",
  staticCredential: true,
  credentialless: false,
  async revoke(lease: CredentialLease) {
    revoked.push({ connectionId: lease.connectionId, apiHosts: lease.definition.apiHosts });
  },
};

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("connections", () => {
  let tableau: TableauStandIn;
  let provider: OAuthStandIn;
  let db: Db;
  let closeDb: (() => Promise<void>) | undefined;
  let h: IdentityHarness;
  let c: ConnectionsHarness;
  let siteId: string;
  const keys = testKeys();

  async function person(user: TableauUser, operator = false): Promise<Person> {
    const { cookie } = await tableauSignIn(h, tableau, user);
    const session = (await h.identity.readSignInSession(cookie)) as SignInSession;
    const { principal } = operator ? await operatorSignIn(h, cookie) : await appSignIn(h, cookie);
    return { principal, session, cookie };
  }

  function oauthDefinition(overrides: Record<string, unknown> = {}) {
    return {
      id: "crm",
      displayName: "CRM",
      type: "oauth2",
      ownership: "personal",
      apiHosts: [`${provider.origin}/api`],
      authorizationEndpoint: `${provider.origin}/authorize`,
      tokenEndpoint: `${provider.origin}/token`,
      clientId: provider.clientId,
      scopes: ["read"],
      audience: [siteId],
      privateHosts: true,
      ...overrides,
    };
  }

  async function setClientSecret(operator: Person, defId: string) {
    const link = await c.connections.createSecretLink(operator.principal, defId, "clientSecret");
    const token = new URL(link.url).pathname.split("/").at(-1) as string;
    await c.connections.submitSecret(token, operator.session, provider.clientSecret);
  }

  /** Runs the whole OAuth connect for a person and returns the transaction ID. */
  async function connect(
    who: Person,
    defId: string,
    mode: "personal" | "shared" = "personal",
    service = c,
  ) {
    const started = await service.connections.startConnect(who.principal, defId, mode);
    const url = await service.connections.beginConnect(started.transactionId, who.session);
    const query = provider.authorize(url);
    await service.connections.completeConnect({ query, session: who.session });
    return started.transactionId;
  }

  before(async () => {
    tableau = await new TableauStandIn().start();
    provider = await new OAuthStandIn().start();
  });
  after(async () => {
    await h.close();
    await closeDb?.();
    await provider.close();
    await tableau.close();
  });
  beforeEach(async () => {
    provider.reset();
    if (closeDb) {
      await h.close();
      await closeDb();
    }
    ({ db, close: closeDb } = await freshDatabase());
    h = await identityHarness(db, tableau);
    revoked.length = 0;
    c = connectionsHarness(db, {
      keys,
      outbound: h.outbound,
      clock: h.clock,
      presets: [revocable],
    });
    // The trusted site binds to its Tableau site ID at the first sign-in.
    await tableauSignIn(h, tableau, operatorUser);
    siteId = ((await listSites(db))[0] as { id: string }).id;
  });

  test("V10 a definition is validated as a whole and every failing field is reported", async () => {
    const op = await person(operatorUser, true);
    const error = await c.definitions
      .create("test", {
        id: "Bad Id",
        displayName: "",
        type: "oauth2",
        ownership: "team",
        apiHosts: ["http://plain.example", "https://ok.example/api"],
        tokenEndpoint: "not a url",
        clientId: "x",
        credentialPlacement: { kind: "header", name: "Host" },
        audience: ["00000000-0000-0000-0000-000000000000"],
        reauthorizationInterval: 5,
        clientSecret: "never-accepted",
        mystery: 1,
      })
      .catch((e) => e);
    const rules = fieldRules(error);
    assert.deepEqual(rules, {
      id: "slug:a-z0-9-,1-63",
      displayName: "printable:1-200",
      ownership: "one-of:shared|personal",
      "apiHosts.0": "https-base-url",
      authorizationEndpoint: "required",
      tokenEndpoint: "https-url",
      "credentialPlacement.name": "header-name",
      "audience.0": "trusted-site",
      reauthorizationInterval: "seconds:60-315360000",
      clientSecret: "use-secret-link",
      mystery: "unknown-field",
    });
    assert.ok(!JSON.stringify(error.toBody()).includes("never-accepted"));
    assert.equal(await db.selectFrom("definitions").select("id").executeTakeFirst(), undefined);

    const view = await c.definitions.create("test", oauthDefinition());
    assert.equal(view.generation, 1);
    assert.equal(view.tokenAuthentication, "basic");
    assert.equal(view.clientSecretSet, false);
    assert.equal(await code(c.definitions.create("test", oauthDefinition())), "definition-exists");
    await setClientSecret(op, "crm");
    const after = await c.definitions.viewForOperators("crm");
    assert.equal(after.clientSecretSet, true);
    assert.ok(!JSON.stringify(after).includes(provider.clientSecret));
    // A patch only takes in-place fields.
    assert.deepEqual(
      fieldRules(
        await c.definitions
          .patch("test", "crm", { apiHosts: ["https://elsewhere.example"] })
          .catch((e) => e),
      ),
      {
        apiHosts: "requires-redefine",
      },
    );
  });

  test("V11 in-place changes keep connections; redefinition and retirement end them; IDs survive", async () => {
    const op = await person(operatorUser, true);
    const a = await person(alice);
    await c.definitions.create("test", oauthDefinition());
    await setClientSecret(op, "crm");
    await connect(a, "crm");
    assert.equal(
      applied(await c.connections.checkout(a.principal, "crm")).headers[0]?.[1],
      "Bearer a-1",
    );

    await c.definitions.patch("test", "crm", {
      displayName: "CRM renamed",
      scopes: ["read", "write"],
    });
    assert.equal(
      applied(await c.connections.checkout(a.principal, "crm", undefined)).headers[0]?.[1],
      "Bearer a-1",
    );

    // Disabling stops checkouts without ending the connection; enabling restores them.
    await c.definitions.patch("test", "crm", { enabled: false });
    assert.equal(await code(c.connections.checkout(a.principal, "crm")), "definition-disabled");
    await c.definitions.patch("test", "crm", { enabled: true });
    await c.connections.checkout(a.principal, "crm");

    const redefined = await c.definitions.redefine(
      "test",
      "crm",
      oauthDefinition({ apiHosts: [`${provider.origin}/v2`] }),
    );
    assert.equal(redefined.generation, 2);
    assert.equal(redefined.connectionsEnded, 1);
    const ended = await db.selectFrom("connections").selectAll().executeTakeFirstOrThrow();
    assert.equal(ended.status, "disconnected");
    assert.equal(ended.sealed, null);
    assert.equal(ended.disconnect_reason, "redefined");
    assert.equal(await code(c.connections.checkout(a.principal, "crm")), "not-connected");
    // The client secret is kept across a redefinition; the same ID works again after reconnecting.
    await connect(a, "crm");
    await c.connections.checkout(a.principal, "crm");

    const retired = await c.definitions.retire("test", "crm");
    assert.equal(retired.connectionsEnded, 1);
    assert.equal(await code(c.connections.checkout(a.principal, "crm")), "definition-disabled");
    assert.equal(
      await db.selectFrom("definition_secrets").select("field").executeTakeFirst(),
      undefined,
    );
    assert.equal(
      (
        await db
          .selectFrom("connections")
          .select("sealed")
          .where("status", "<>", "disconnected")
          .execute()
      ).length,
      0,
    );
    assert.equal(await code(c.definitions.create("test", oauthDefinition())), "definition-exists");
    assert.equal(
      await code(c.definitions.patch("test", "crm", { enabled: true })),
      "definition-retired",
    );
  });

  test("V11 a definition changed during setup fails the callback with definition-changed", async () => {
    const op = await person(operatorUser, true);
    const a = await person(alice);
    await c.definitions.create("test", oauthDefinition());
    await setClientSecret(op, "crm");
    const started = await c.connections.startConnect(a.principal, "crm", "personal");
    const url = await c.connections.beginConnect(started.transactionId, a.session);
    await c.definitions.redefine("test", "crm", oauthDefinition({ scopes: ["other"] }));
    const query = provider.authorize(url);
    assert.equal(
      await code(c.connections.completeConnect({ query, session: a.session })),
      "definition-changed",
    );
    const tx = await db.selectFrom("connect_transactions").selectAll().executeTakeFirstOrThrow();
    assert.equal(tx.failure, "definition-changed");
    assert.equal(await db.selectFrom("connections").select("id").executeTakeFirst(), undefined);

    // Redefinition between the token exchange and storing is caught by the generation recheck.
    const second = await c.connections.startConnect(a.principal, "crm", "personal");
    const url2 = await c.connections.beginConnect(second.transactionId, a.session);
    const query2 = provider.authorize(url2);
    provider.faults = { delayMs: 300 };
    const pending = c.connections.completeConnect({ query: query2, session: a.session });
    await new Promise((r) => setTimeout(r, 100));
    await c.definitions.redefine("test", "crm", oauthDefinition({ scopes: ["third"] }));
    assert.equal(await code(pending), "definition-changed");
    assert.equal(await db.selectFrom("connections").select("id").executeTakeFirst(), undefined);
  });

  test("V12 two replicas see a definition change on their next checkout", async () => {
    const op = await person(operatorUser, true);
    const a = await person(alice);
    const replica = connectionsHarness(db, { keys, outbound: h.outbound, clock: h.clock });
    await c.definitions.create("test", oauthDefinition());
    await setClientSecret(op, "crm");
    await connect(a, "crm");
    await replica.connections.checkout(a.principal, "crm");
    await c.definitions.patch("test", "crm", { enabled: false });
    // The replica's cache is still fresh, yet the checkout's own query sees the disabled flag.
    assert.equal(
      await code(replica.connections.checkout(a.principal, "crm")),
      "definition-disabled",
    );
    await c.definitions.patch("test", "crm", { enabled: true, audience: [] });
    h.clock.offsetMs += 1100;
    assert.equal(await code(replica.connections.checkout(a.principal, "crm")), "not-in-audience");
    assert.equal((await replica.definitions.get("crm"))?.audience.length, 0);
    await c.definitions.patch("test", "crm", { audience: [siteId] });
    await c.definitions.redefine("test", "crm", oauthDefinition({ scopes: ["x"] }));
    // A redefinition is seen immediately too: the generation moved, so the stale connection is not issued.
    assert.equal(await code(replica.connections.checkout(a.principal, "crm")), "not-connected");
    assert.equal((await replica.definitions.get("crm"))?.generation, 2);
  });

  test("V13 personal checkout never returns a shared connection", async () => {
    const op = await person(operatorUser, true);
    const a = await person(alice);
    const b = await person(bob);
    await c.definitions.create("test", oauthDefinition({ id: "crm-shared", ownership: "shared" }));
    await c.definitions.create("test", oauthDefinition({ id: "crm-mine" }));
    await setClientSecret(op, "crm-shared");
    await setClientSecret(op, "crm-mine");
    await connect(op, "crm-shared", "shared");
    // Everyone in the audience uses the shared connection.
    assert.equal(
      applied(await c.connections.checkout(a.principal, "crm-shared")).headers[0]?.[1],
      "Bearer a-1",
    );
    assert.equal(
      applied(await c.connections.checkout(b.principal, "crm-shared")).headers[0]?.[1],
      "Bearer a-1",
    );
    // The personal definition has no fallback to anything shared, and each person sees only their own.
    assert.equal(await code(c.connections.checkout(a.principal, "crm-mine")), "not-connected");
    await connect(a, "crm-mine");
    assert.equal(
      applied(await c.connections.checkout(a.principal, "crm-mine")).headers[0]?.[1],
      "Bearer a-2",
    );
    assert.equal(await code(c.connections.checkout(b.principal, "crm-mine")), "not-connected");
    // A shared definition is never connected by a viewer, nor a personal one by an operator for others.
    assert.equal(
      await code(c.connections.startConnect(a.principal, "crm-shared", "personal")),
      "shared-definition",
    );
    assert.equal(
      await code(c.connections.startConnect(op.principal, "crm-mine", "shared")),
      "personal-definition",
    );
    const listed = await c.connections.listForApp(b.principal);
    assert.deepEqual(
      listed.map((d) => [d.id, d.ownership, d.status]),
      [
        ["crm-mine", "personal", "not-connected"],
        ["crm-shared", "shared", "connected"],
      ],
    );
  });

  test("V14 concurrent refreshes on two replicas call the token endpoint once", async () => {
    const op = await person(operatorUser, true);
    const a = await person(alice);
    const replica = connectionsHarness(db, { keys, outbound: h.outbound, clock: h.clock });
    await c.definitions.create("test", oauthDefinition());
    await setClientSecret(op, "crm");
    provider.expiresIn = 30;
    await connect(a, "crm");
    const authorizedAt = (
      await db.selectFrom("connections").select("authorized_at").executeTakeFirstOrThrow()
    ).authorized_at;
    provider.tokenRequests = [];
    provider.expiresIn = 3600;
    provider.faults = { delayMs: 150 };
    const leases = await Promise.all([
      c.connections.checkout(a.principal, "crm"),
      replica.connections.checkout(a.principal, "crm"),
      c.connections.checkout(a.principal, "crm"),
      replica.connections.checkout(a.principal, "crm"),
    ]);
    assert.equal(provider.tokenRequests.filter((r) => r.grantType === "refresh_token").length, 1);
    for (const lease of leases) assert.equal(applied(lease).headers[0]?.[1], "Bearer a-2");
    const row = await db.selectFrom("connections").selectAll().executeTakeFirstOrThrow();
    assert.equal(row.authorized_at.getTime(), authorizedAt.getTime());
    assert.ok((row.credential_expires_at as Date).getTime() > Date.now() + 3000_000);
  });

  test("V14 a rejected refresh needs authorization; an unknown outcome keeps the credential", async () => {
    const op = await person(operatorUser, true);
    const a = await person(alice);
    await c.definitions.create("test", oauthDefinition());
    await setClientSecret(op, "crm");
    provider.expiresIn = 30;
    await connect(a, "crm");
    const before = (await db.selectFrom("connections").select("sealed").executeTakeFirstOrThrow())
      .sealed;
    provider.faults = { drop: true };
    assert.equal(await code(c.connections.checkout(a.principal, "crm")), "refresh-uncertain");
    provider.faults = { status: 503 };
    assert.equal(await code(c.connections.checkout(a.principal, "crm")), "refresh-uncertain");
    const kept = await db
      .selectFrom("connections")
      .select(["sealed", "status"])
      .executeTakeFirstOrThrow();
    assert.deepEqual(kept, { sealed: before, status: "connected" });
    provider.faults = { rejectRefresh: true };
    assert.equal(await code(c.connections.checkout(a.principal, "crm")), "needs-authorization");
    assert.equal(
      (await db.selectFrom("connections").select("status").executeTakeFirstOrThrow()).status,
      "needs-authorization",
    );
    assert.equal(await code(c.connections.checkout(a.principal, "crm")), "needs-authorization");
    provider.faults = {};
    await connect(a, "crm");
    await c.connections.checkout(a.principal, "crm");
  });

  test("V15 a connect page refuses a sign-in cookie whose identity does not match the transaction", async () => {
    const op = await person(operatorUser, true);
    const a = await person(alice);
    const b = await person(bob);
    await c.definitions.create("test", oauthDefinition());
    await setClientSecret(op, "crm");
    const started = await c.connections.startConnect(a.principal, "crm", "personal");
    assert.match(started.url, /^https:\/\/service\.test\/connect\//);
    // Bob opens Alice's link.
    assert.equal(
      await code(c.connections.beginConnect(started.transactionId, b.session)),
      "identity-mismatch",
    );
    const url = await c.connections.beginConnect(started.transactionId, a.session);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("scope"), "read");
    assert.equal(url.searchParams.get("redirect_uri"), "https://service.test/v1/oauth/callback");
    // The callback lands in Bob's browser.
    const query = provider.authorize(url);
    assert.equal(
      await code(c.connections.completeConnect({ query, session: b.session })),
      "identity-mismatch",
    );
    assert.equal(
      await code(c.connections.completeConnect({ query, session: a.session })),
      "connect-transaction-invalid",
    );
    assert.equal(await db.selectFrom("connections").select("id").executeTakeFirst(), undefined);
    // A shared connect needs an operator sign-in even with a matching identity.
    await c.definitions.create("test", oauthDefinition({ id: "crm-shared", ownership: "shared" }));
    await setClientSecret(op, "crm-shared");
    const shared = await c.connections.startConnect(op.principal, "crm-shared", "shared");
    assert.equal(
      await code(c.connections.beginConnect(shared.transactionId, a.session)),
      "identity-mismatch",
    );
  });

  test("static credentials, placements, secret links and disconnect", async () => {
    const op = await person(operatorUser, true);
    const a = await person(alice);
    await c.definitions.create("test", {
      id: "keyed",
      displayName: "Keyed",
      type: "static",
      ownership: "personal",
      apiHosts: [`${provider.origin}/api`],
      credentialPlacement: { kind: "query", name: "api_key" },
      audience: [siteId],
    });
    assert.equal(await code(c.connections.checkout(a.principal, "keyed")), "not-connected");
    const listed = await c.connections.setPersonalCredential(a.principal, "keyed", "k-123");
    assert.equal(listed?.status, "connected");
    assert.equal(
      applied(await c.connections.checkout(a.principal, "keyed"), "/v1/x?api_key=old&y=1").target,
      "/v1/x?y=1&api_key=k-123",
    );
    const dump = JSON.stringify(await db.selectFrom("connections").selectAll().execute());
    assert.ok(!dump.includes("k-123"));

    await c.definitions.create("test", {
      id: "keyed-shared",
      displayName: "Keyed shared",
      type: "static",
      ownership: "shared",
      apiHosts: [`${provider.origin}/api`],
      credentialPlacement: { kind: "header", name: "X-Api-Key", prefix: "Key " },
      audience: [siteId],
    });
    assert.equal(
      await code(c.connections.setPersonalCredential(a.principal, "keyed-shared", "nope")),
      "shared-definition",
    );
    const link = await c.connections.createSecretLink(op.principal, "keyed-shared", "credential");
    const token = new URL(link.url).pathname.split("/").at(-1) as string;
    assert.equal(await code(c.connections.readSecretLink(token, a.session)), "operator-required");
    assert.equal((await c.connections.readSecretLink(token, op.session)).field, "credential");
    await c.connections.submitSecret(token, op.session, "shared-key");
    assert.equal(
      await code(c.connections.submitSecret(token, op.session, "again")),
      "secret-link-invalid",
    );
    const request: OutgoingRequest = {
      target: "/x",
      headers: [
        ["x-api-key", "app-sent"],
        ["accept", "*/*"],
      ],
    };
    (await c.connections.checkout(a.principal, "keyed-shared")).apply(request);
    assert.deepEqual(request.headers, [
      ["accept", "*/*"],
      ["X-Api-Key", "Key shared-key"],
    ]);

    // Links expire after fifteen minutes.
    const late = await c.connections.createSecretLink(op.principal, "keyed-shared", "credential");
    h.clock.offsetMs += 15 * 60_000 + 1000;
    const lateToken = new URL(late.url).pathname.split("/").at(-1) as string;
    assert.equal(
      await code(c.connections.submitSecret(lateToken, op.session, "late")),
      "secret-link-invalid",
    );
    h.clock.offsetMs = 0;

    assert.equal(await c.connections.disconnectOwn(a.principal, "keyed"), true);
    assert.equal(await code(c.connections.checkout(a.principal, "keyed")), "not-connected");
    assert.equal(await c.connections.disconnectOwn(a.principal, "keyed"), false);
    const [shared] = await c.connections.listConnections({ definitionId: "keyed-shared" });
    assert.ok(shared);
    assert.equal(await c.connections.disconnectAny(op.principal, shared.id), true);
    assert.equal(await code(c.connections.checkout(a.principal, "keyed-shared")), "not-connected");
  });

  test("audience pruning, reauthorization interval and credentialless definitions", async () => {
    const op = await person(operatorUser, true);
    const a = await person(alice);
    await c.definitions.create("test", oauthDefinition({ reauthorizationInterval: 600 }));
    await setClientSecret(op, "crm");
    await connect(a, "crm");
    h.clock.offsetMs += 601_000;
    assert.equal(await code(c.connections.checkout(a.principal, "crm")), "needs-authorization");
    h.clock.offsetMs = 0;

    await c.definitions.create("test", {
      id: "open-data",
      displayName: "Open data",
      type: "none",
      ownership: "shared",
      apiHosts: [`${provider.origin}/api`],
      audience: [siteId],
    });
    const lease = await c.connections.checkout(a.principal, "open-data");
    assert.equal(lease.connectionId, null);
    assert.deepEqual(applied(lease).headers, []);

    const other = await addSite(db, "test", { deploymentId: DEPLOYMENT, contentUrl: "beta" });
    await c.definitions.patch("test", "open-data", { audience: [siteId, other.id] });
    await removeSite(db, "test", other.id);
    h.clock.offsetMs += 1100;
    assert.deepEqual((await c.definitions.get("open-data"))?.audience, [siteId]);
  });

  test("a shared OAuth connect cannot be finished by an operator removed during consent", async () => {
    const op = await person(operatorUser, true);
    await c.definitions.create("test", oauthDefinition({ id: "crm-shared", ownership: "shared" }));
    await setClientSecret(op, "crm-shared");
    const started = await c.connections.startConnect(op.principal, "crm-shared", "shared");
    const url = await c.connections.beginConnect(started.transactionId, op.session);
    const query = provider.authorize(url);
    // Another operator removes this one while the provider shows its consent screen.
    await addOperator(db, "test", {
      deploymentId: DEPLOYMENT,
      siteContentUrl: "alpha",
      username: "other@example.com",
    });
    const self = (await listOperators(db)).find((o) => o.username === operatorUser.userName);
    assert.ok(self);
    await removeOperator(db, "test", self.id);
    assert.equal(
      await code(c.connections.completeConnect({ query, session: op.session })),
      "operator-required",
    );
    assert.equal(await db.selectFrom("connections").select("id").executeTakeFirst(), undefined);
    const tx = await db
      .selectFrom("connect_transactions")
      .select(["status", "failure"])
      .where("id", "=", started.transactionId)
      .executeTakeFirstOrThrow();
    assert.deepEqual(tx, { status: "failed", failure: "operator-required" });
  });

  test("an operator removal that races the shared connect commit waits for it, never slips past", async () => {
    const op = await person(operatorUser, true);
    await c.definitions.create("test", oauthDefinition({ id: "crm-shared", ownership: "shared" }));
    await setClientSecret(op, "crm-shared");
    await addOperator(db, "test", {
      deploymentId: DEPLOYMENT,
      siteContentUrl: "alpha",
      username: "other@example.com",
    });
    const self = (await listOperators(db)).find((o) => o.username === operatorUser.userName);
    assert.ok(self);
    const started = await c.connections.startConnect(op.principal, "crm-shared", "shared");
    const query = provider.authorize(
      await c.connections.beginConnect(started.transactionId, op.session),
    );
    // A separate session holds the connection slot lock, so the commit transaction stops just
    // after it has read the operator's authority. The removal runs inside that window.
    const slot = `connection:crm-shared:shared`;
    await db.connection().execute(async (holder) => {
      await sql`select pg_advisory_lock(hashtextextended(${slot}, 0))`.execute(holder);
      const waiting = async (lockType: string) =>
        Number(
          (
            await sql<{
              n: string;
            }>`select count(*) as n from pg_locks where not granted and locktype = ${lockType}`.execute(
              db,
            )
          ).rows[0]?.n,
        ) > 0;
      const connecting = c.connections.completeConnect({ query, session: op.session });
      await until(() => waiting("advisory"), "the commit to reach the slot lock");
      let removed = false;
      const removal = removeOperator(db, "test", self.id).then(() => {
        removed = true;
      });
      // Either the removal commits at once, or it waits on the operator row the commit holds.
      await until(
        async () => removed || (await waiting("transactionid")) || (await waiting("tuple")),
        "the removal to commit or wait",
      );
      assert.equal(removed, false, "the removal must wait for the shared connect to commit");
      await sql`select pg_advisory_unlock(hashtextextended(${slot}, 0))`.execute(holder);
      await connecting;
      await removal;
    });
    // The connect committed while the operator still held authority; the removal followed it.
    assert.equal(
      (
        await db
          .selectFrom("connections")
          .select("id")
          .where("definition_id", "=", "crm-shared")
          .execute()
      ).length,
      1,
    );
    assert.equal(
      (await listOperators(db)).some((o) => o.id === self.id),
      false,
    );
  });

  test("a secret link is spent only on the generation it was created for", async () => {
    const op = await person(operatorUser, true);
    const a = await person(alice);
    const shared = {
      id: "keyed",
      displayName: "Keyed",
      type: "static",
      ownership: "shared",
      apiHosts: [`${provider.origin}/api`],
      audience: [siteId],
    };
    await c.definitions.create("test", shared);
    const link = await c.connections.createSecretLink(op.principal, "keyed", "credential");
    const token = new URL(link.url).pathname.split("/").at(-1) as string;
    // The definition becomes personal before the link is used.
    await c.definitions.redefine("test", "keyed", { ...shared, ownership: "personal" });
    assert.equal(
      await code(c.connections.submitSecret(token, op.session, "shared-key")),
      "definition-changed",
    );
    assert.equal(await db.selectFrom("connections").select("id").executeTakeFirst(), undefined);
    assert.equal(await code(c.connections.checkout(a.principal, "keyed")), "not-connected");

    // A client-secret link is equally bound to its generation.
    await c.definitions.create("test", oauthDefinition());
    const secretLink = await c.connections.createSecretLink(op.principal, "crm", "clientSecret");
    await c.definitions.redefine("test", "crm", oauthDefinition({ scopes: ["other"] }));
    assert.equal(
      await code(
        c.connections.submitSecret(
          new URL(secretLink.url).pathname.split("/").at(-1) as string,
          op.session,
          "secret",
        ),
      ),
      "definition-changed",
    );
  });

  test("disconnect revokes with the definition the credential was issued under", async () => {
    const a = await person(alice);
    const base = {
      id: "rev",
      displayName: "Revocable",
      type: "revocable",
      ownership: "personal",
      apiHosts: [`${provider.origin}/api`],
      audience: [siteId],
    };
    await c.definitions.create("test", base);
    await c.connections.setPersonalCredential(a.principal, "rev", "k-1");
    const [connection] = await c.connections.listConnections({ definitionId: "rev" });
    assert.ok(connection);
    // An operator redefines the definition right after the disconnect commits. Opening the sealed
    // credential is the first thing the disconnect does after its commit, so the redefinition starts
    // there, and any definition read after that point waits for it and sees the new destination.
    let redefined: Promise<unknown> | undefined;
    const redefine = () => {
      redefined ??= c.definitions.redefine("test", "rev", {
        ...base,
        apiHosts: [`${provider.origin}/elsewhere`],
      });
      return redefined;
    };
    const open = c.sealer.open.bind(c.sealer);
    c.sealer.open = (...args: Parameters<typeof open>) => {
      void redefine();
      return open(...args);
    };
    const get = c.definitions.get.bind(c.definitions);
    let reads = 0;
    c.definitions.get = async (id: string) => {
      if (++reads > 1) await redefine();
      return await get(id);
    };
    const revoke = revocable.revoke as NonNullable<ProviderType["revoke"]>;
    revocable.revoke = async (lease, context) => {
      await redefine();
      await revoke(lease, context);
    };
    try {
      assert.equal(await c.connections.disconnectOwn(a.principal, "rev"), true);
    } finally {
      c.sealer.open = open;
      c.definitions.get = get;
      revocable.revoke = revoke;
    }
    assert.ok(redefined, "the definition was redefined during the disconnect");
    assert.equal((await c.definitions.get("rev"))?.apiHosts[0], `${provider.origin}/elsewhere`);
    assert.deepEqual(revoked, [
      { connectionId: connection.id, apiHosts: [`${provider.origin}/api`] },
    ]);
  });

  test("two first connections for the same slot at once leave one live connection", async () => {
    const a = await person(alice);
    await c.definitions.create("test", {
      id: "keyed",
      displayName: "Keyed",
      type: "static",
      ownership: "personal",
      apiHosts: [`${provider.origin}/api`],
      audience: [siteId],
    });
    const other = connectionsHarness(db, { keys, outbound: h.outbound, clock: h.clock });
    await Promise.all([
      c.connections.setPersonalCredential(a.principal, "keyed", "k-1"),
      other.connections.setPersonalCredential(a.principal, "keyed", "k-2"),
    ]);
    const live = await db
      .selectFrom("connections")
      .select("id")
      .where("status", "<>", "disconnected")
      .execute();
    assert.equal(live.length, 1);
  });
});
