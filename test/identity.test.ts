import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import {
  addOperator,
  addSite,
  isOperator,
  listOperators,
  listSites,
  removeOperator,
  setSiteEnabled,
} from "../src/identity/directory.ts";
import { sameIdentity } from "../src/identity/types.ts";
import type { Db } from "../src/persistence/database.ts";
import { ServiceError } from "../src/platform/errors.ts";
import { pkceChallenge, randomToken } from "../src/platform/secrets.ts";
import { freshDatabase } from "./support/db.ts";
import {
  appSignIn,
  DEPLOYMENT,
  type IdentityHarness,
  identityHarness,
  operatorSignIn,
  tableauSignIn,
} from "./support/identity.ts";
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

const alice: TableauUser = {
  siteId: "site-a",
  siteContentUrl: "alpha",
  userId: "user-a",
  userName: "alice@example.com",
  email: "alice@example.com",
};
const operator: TableauUser = {
  siteId: "site-a",
  siteContentUrl: "alpha",
  userId: "user-op",
  userName: "op@example.com",
};

describe("identity", () => {
  let tableau: TableauStandIn;
  let db: Db;
  let closeDb: () => Promise<void>;
  let h: IdentityHarness;

  before(async () => {
    tableau = await new TableauStandIn().start();
  });
  after(() => tableau.close());
  beforeEach(async () => {
    tableau.faults = {};
    if (closeDb) {
      await h.close();
      await closeDb();
    }
    ({ db, close: closeDb } = await freshDatabase());
    h = await identityHarness(db, tableau);
  });
  after(async () => {
    await h.close();
    await closeDb();
  });

  test("V3 a valid Tableau sign-in yields an identity from sessions/current and keeps no Tableau token", async () => {
    const result = await tableauSignIn(h, tableau, alice, "/sign-in/abc");
    assert.equal(result.returnTo, "/sign-in/abc");
    assert.deepEqual(result.session.identity, {
      deploymentId: DEPLOYMENT,
      siteId: "site-a",
      userId: "user-a",
    });
    const row = await db.selectFrom("identities").selectAll().executeTakeFirstOrThrow();
    assert.equal(row.user_name, "alice@example.com");
    assert.equal(
      await db.selectFrom("sign_in_transactions").select("id").executeTakeFirst(),
      undefined,
    );
    const dump = JSON.stringify(await db.selectFrom("sign_in_sessions").selectAll().execute());
    assert.ok(!dump.includes("Bearer"));
  });

  test("V3 state, PKCE, nonce, signature, audience, at_hash, userinfo and session are each enforced", async () => {
    const begun = await h.identity.beginTableauSignIn({ deploymentId: DEPLOYMENT, returnTo: "/x" });
    const query = tableau.authorize(begun.authorizationUrl, alice);
    const wrongState = new URLSearchParams(query);
    wrongState.set("state", "forged");
    assert.equal(
      await code(
        h.identity.completeTableauSignIn({ query: wrongState, browserToken: begun.browserToken }),
      ),
      "sign-in-transaction-invalid",
    );
    assert.equal(
      await code(h.identity.completeTableauSignIn({ query, browserToken: "other-browser" })),
      "sign-in-transaction-invalid",
    );
    // The transaction is spent by the first attempt; replay fails.
    assert.equal(
      await code(h.identity.completeTableauSignIn({ query, browserToken: begun.browserToken })),
      "sign-in-transaction-invalid",
    );

    for (const fault of [
      { nonce: true },
      { signature: true },
      { audience: true },
      { atHash: "missing" as const },
      { atHash: "wrong" as const },
      { userinfoSubject: true },
      { sessionStatus: 401 },
    ]) {
      tableau.faults = fault;
      assert.equal(
        await code(tableauSignIn(h, tableau, alice)),
        "identity-verification-failed",
        JSON.stringify(fault),
      );
    }
    tableau.faults = { sessionStatus: 503 };
    assert.equal(await code(tableauSignIn(h, tableau, alice)), "tableau-unavailable");
    tableau.faults = {};
    // PKCE: a code exchanged with another verifier is refused by Tableau and the sign-in fails.
    const b2 = await h.identity.beginTableauSignIn({ deploymentId: DEPLOYMENT, returnTo: "/x" });
    const tampered = new URL(b2.authorizationUrl);
    tampered.searchParams.set("code_challenge", pkceChallenge(randomToken()));
    const q2 = tableau.authorize(tampered, alice);
    assert.equal(
      await code(h.identity.completeTableauSignIn({ query: q2, browserToken: b2.browserToken })),
      "identity-verification-failed",
    );
    assert.equal(
      await db.selectFrom("sign_in_sessions").select("id").executeTakeFirst(),
      undefined,
    );
  });

  test("V3 an untrusted site fails with site-not-trusted naming the content URL", async () => {
    const error = await tableauSignIn(h, tableau, {
      ...alice,
      siteId: "site-z",
      siteContentUrl: "zulu",
    }).catch((e) => e);
    assert.equal(error.code, "site-not-trusted");
    assert.match(error.message, /zulu/);
  });

  test("V4 the same username on two sites is two identities", async () => {
    await addSite(db, "test", { deploymentId: DEPLOYMENT, contentUrl: "beta" });
    const one = await tableauSignIn(h, tableau, alice);
    const two = await tableauSignIn(h, tableau, {
      ...alice,
      siteId: "site-b",
      siteContentUrl: "beta",
      userId: "user-a2",
    });
    assert.ok(!sameIdentity(one.session.identity, two.session.identity));
    assert.notEqual(one.session.identityId, two.session.identityId);
    const same = await tableauSignIn(h, tableau, { ...alice, userName: "renamed@example.com" });
    assert.equal(same.session.identityId, one.session.identityId);
  });

  test("V5 trusted site and operator bind on first sign-in and never match by name afterwards", async () => {
    await tableauSignIn(h, tableau, operator);
    const [site] = await listSites(db);
    assert.equal(site?.siteId, "site-a");
    const [op] = await listOperators(db);
    assert.equal(op?.userId, "user-op");
    // The site is renamed in Tableau: trust follows the ID.
    const renamed = await tableauSignIn(h, tableau, { ...alice, siteContentUrl: "alpha-renamed" });
    assert.equal(renamed.session.trustedSiteId, site?.id);
    // A different site that now uses the old content URL is not trusted.
    assert.equal(
      await code(
        tableauSignIn(h, tableau, { ...alice, siteId: "site-imposter", siteContentUrl: "alpha" }),
      ),
      "site-not-trusted",
    );
    // A different user with the bound operator's username is not an operator.
    const imposter = await tableauSignIn(h, tableau, { ...operator, userId: "user-other" });
    assert.equal(await isOperator(db, imposter.session.identity), false);
    assert.equal(
      await isOperator(db, { deploymentId: DEPLOYMENT, siteId: "site-a", userId: "user-op" }),
      true,
    );
  });

  test("V6 no Tableau role grants operator status", async () => {
    const admin = await tableauSignIn(h, tableau, { ...alice, userName: "siteadmin@example.com" });
    assert.equal(await isOperator(db, admin.session.identity), false);
    const session = await h.identity.readSignInSession(admin.cookie);
    assert.ok(session);
    const id = await h.identity.beginOperatorSignIn({
      mode: "popup",
      codeChallenge: pkceChallenge(randomToken()),
    });
    assert.equal(await code(h.identity.prepareOperatorConsent(id, session)), "operator-required");
  });

  test("V7 app sign-in needs the matching proof and a single-use code", async () => {
    const { cookie } = await tableauSignIn(h, tableau, alice);
    const session = await h.identity.readSignInSession(cookie);
    assert.ok(session);
    const proof = randomToken();
    const { transactionId } = await h.identity.startAppSignIn({
      proofHash: pkceChallenge(proof),
      appId: "app-one",
      attribution: {},
    });
    const completion = await h.identity.issueCompletionCode(transactionId, session);
    assert.equal(
      await code(
        h.identity.redeemAppSignIn(transactionId, { code: completion, proof: randomToken() }),
      ),
      "sign-in-transaction-invalid",
    );
    assert.equal(
      await code(h.identity.redeemAppSignIn(transactionId, { code: randomToken(), proof })),
      "sign-in-transaction-invalid",
    );
    const redeemed = await h.identity.redeemAppSignIn(transactionId, { code: completion, proof });
    assert.equal(redeemed.principal.kind, "app");
    assert.equal(redeemed.principal.location.verified, false);
    assert.equal(
      await code(h.identity.redeemAppSignIn(transactionId, { code: completion, proof })),
      "sign-in-transaction-invalid",
    );
    assert.equal(await h.identity.appSignInPending(transactionId), false);
    const principal = await h.identity.authenticate(redeemed.bearer);
    assert.equal(principal?.appId, "app-one");
    const stored = await db
      .selectFrom("app_sessions")
      .select("bearer_hash")
      .executeTakeFirstOrThrow();
    assert.notEqual(stored.bearer_hash, redeemed.bearer);
  });

  test("V7 app sign-in transactions expire after ten minutes", async () => {
    const { cookie } = await tableauSignIn(h, tableau, alice);
    const session = await h.identity.readSignInSession(cookie);
    assert.ok(session);
    const { transactionId } = await h.identity.startAppSignIn({
      proofHash: pkceChallenge(randomToken()),
      appId: "a",
      attribution: {},
    });
    h.clock.offsetMs = 601_000;
    assert.equal(await h.identity.appSignInPending(transactionId), false);
    assert.equal(
      await code(h.identity.issueCompletionCode(transactionId, session)),
      "sign-in-transaction-invalid",
    );
  });

  test("V7 restore issues a bearer from a valid restore cookie and refuses once the site is untrusted", async () => {
    const { cookie } = await tableauSignIn(h, tableau, alice);
    const first = await appSignIn(h, cookie);
    const restored = await h.identity.restore(first.restoreToken, {
      appId: "app-two",
      attribution: { workbook: "w2" },
    });
    assert.equal(restored.principal.appId, "app-two");
    assert.equal(restored.principal.identityId, first.principal.identityId);
    assert.equal(
      await code(h.identity.restore(randomToken(), { appId: "app-two" })),
      "sign-in-required",
    );
    assert.equal(
      await code(h.identity.restore(undefined, { appId: "app-two" })),
      "sign-in-required",
    );
    const apps = await h.identity.listApps();
    assert.deepEqual(apps.map((a) => a.appId).sort(), ["app-one", "app-two"]);
    const [site] = await listSites(db);
    await setSiteEnabled(db, "test", site?.id as string, false);
    assert.equal(
      await code(h.identity.restore(first.restoreToken, { appId: "app-two" })),
      "sign-in-required",
    );
    assert.equal(await h.identity.authenticate(restored.bearer), undefined);
    assert.equal(await h.identity.readSignInSession(cookie), undefined);
  });

  test("V7a app and restored bearers never carry operator authority", async () => {
    const { cookie } = await tableauSignIn(h, tableau, operator);
    const app = await appSignIn(h, cookie);
    const restored = await h.identity.restore(app.restoreToken, { appId: "x" });
    assert.equal(await code(h.identity.authenticateOperator(app.bearer)), "operator-required");
    assert.equal(await code(h.identity.authenticateOperator(restored.bearer)), "operator-required");
    const op = await operatorSignIn(h, cookie);
    const principal = await h.identity.authenticateOperator(op.bearer);
    assert.equal(principal.kind, "operator");
    // Operator status is checked against the operators table on every call.
    await addOperator(db, "test", {
      deploymentId: DEPLOYMENT,
      siteContentUrl: "alpha",
      username: "second@example.com",
    });
    const [first] = await listOperators(db);
    await removeOperator(db, "test", first?.id as string);
    assert.equal(await code(h.identity.authenticateOperator(op.bearer)), "operator-required");
  });

  test("operator codes need the PKCE verifier, are single use and need consent", async () => {
    const { cookie } = await tableauSignIn(h, tableau, operator);
    const session = await h.identity.readSignInSession(cookie);
    assert.ok(session);
    const verifier = randomToken();
    const id = await h.identity.beginOperatorSignIn({
      mode: "loopback",
      redirectUri: "http://127.0.0.1:5000/cb",
      codeChallenge: pkceChallenge(verifier),
      state: "s1",
    });
    assert.equal(
      await code(h.identity.approveOperatorSignIn(id, randomToken(), session)),
      "sign-in-transaction-invalid",
    );
    const { consent } = await h.identity.prepareOperatorConsent(id, session);
    const approved = await h.identity.approveOperatorSignIn(id, consent, session);
    assert.equal(approved.redirectUri, "http://127.0.0.1:5000/cb");
    assert.equal(approved.state, "s1");
    assert.equal(
      await code(h.identity.redeemOperatorCode({ code: approved.code, verifier: randomToken() })),
      "sign-in-transaction-invalid",
    );
    await h.identity.redeemOperatorCode({ code: approved.code, verifier });
    assert.equal(
      await code(h.identity.redeemOperatorCode({ code: approved.code, verifier })),
      "sign-in-transaction-invalid",
    );
    assert.equal(
      await code(
        h.identity.beginOperatorSignIn({
          mode: "loopback",
          redirectUri: "https://evil.example/cb",
          codeChallenge: pkceChallenge(verifier),
        }),
      ),
      "invalid-request",
    );
  });

  test("V8 the sign-in limit is enforced and only a Tableau sign-in moves it", async () => {
    const { cookie, session } = await tableauSignIn(h, tableau, alice);
    const app = await appSignIn(h, cookie);
    h.clock.offsetMs = 6 * 86400_000;
    const restored = await h.identity.restore(app.restoreToken, { appId: "x" });
    assert.equal(restored.principal.expiresAt.getTime(), session.expiresAt.getTime());
    await appSignIn(h, cookie);
    const identityRow = await db
      .selectFrom("identities")
      .select("last_verified_at")
      .executeTakeFirstOrThrow();
    assert.equal(identityRow.last_verified_at.getTime(), session.verifiedAt.getTime());
    h.clock.offsetMs = 7 * 86400_000 + 1000;
    assert.equal(await h.identity.authenticate(app.bearer), undefined);
    assert.equal(await h.identity.authenticate(restored.bearer), undefined);
    assert.equal(
      await code(h.identity.restore(app.restoreToken, { appId: "x" })),
      "sign-in-required",
    );
    assert.equal(await h.identity.readSignInSession(cookie), undefined);
    const fresh = await tableauSignIn(h, tableau, alice);
    assert.ok(fresh.session.verifiedAt.getTime() > session.verifiedAt.getTime());
  });

  test("revoking an identity's sessions ends every bearer and restore cookie", async () => {
    const { cookie, session } = await tableauSignIn(h, tableau, alice);
    const app = await appSignIn(h, cookie);
    assert.equal(await h.identity.revokeSessions("op", session.identity), 1);
    assert.equal(await h.identity.authenticate(app.bearer), undefined);
    assert.equal(
      await code(h.identity.restore(app.restoreToken, { appId: "x" })),
      "sign-in-required",
    );
  });

  test("the last operator cannot be removed and bootstrap is applied once", async () => {
    const [only] = await listOperators(db);
    assert.equal(await code(removeOperator(db, "test", only?.id as string)), "last-operator");
    const again = await identityHarness(db, tableau, {
      site: "other",
      operator: { site: "other", username: "x" },
    });
    await again.close();
    assert.equal((await listSites(db)).length, 1);
    assert.equal((await listOperators(db)).length, 1);
    const line = again.lines.find((l) => l.includes("bootstrap entries ignored"));
    assert.ok(line);
    assert.match(line, /firstSite/);
    assert.match(line, /firstOperator/);
  });

  test("app declarations are labels with printable limits only", async () => {
    assert.equal(
      await code(h.identity.startAppSignIn({ proofHash: "short", appId: "" })),
      "invalid-request",
    );
    const ok = await h.identity.startAppSignIn({
      proofHash: pkceChallenge("p"),
      appId: "Any Label ✓ 1",
      attribution: { view: "Sheet 1" },
    });
    assert.ok(ok.transactionId);
  });
});
