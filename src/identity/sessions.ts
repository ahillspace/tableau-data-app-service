import { sql } from "kysely";
import { type Db, type Queryable, type Tx, transaction } from "../persistence/database.ts";
import type { Clock } from "../platform/clock.ts";
import { invalid, ServiceError } from "../platform/errors.ts";
import type { Log } from "../platform/log.ts";
import { hashToken, pkceChallenge, randomToken, sameSecret } from "../platform/secrets.ts";
import { bindOperator, isOperator, matchAndBindSite } from "./directory.ts";
import {
  type DeploymentAdapter,
  TABLEAU_CALLBACK_PATH,
  tableauClientMetadata,
} from "./tableau-cloud.ts";
import type { Attribution, Identity, Principal, SignInSession } from "./types.ts";

const TRANSACTION_SECONDS = 600;
const PRINTABLE = /^[\x20-\x7e -￿]+$/u;

export function signInRequired(): ServiceError {
  return new ServiceError(401, "sign-in-required", "Sign in with Tableau to continue");
}

/** The app ID is a printable label; attribution fields are optional printable strings. */
export function readAppDeclaration(input: { appId?: unknown; attribution?: unknown }): {
  appId: string;
  attribution: Attribution;
} {
  const fields = [];
  const appId = input.appId;
  if (typeof appId !== "string" || appId.length < 1 || appId.length > 200 || !PRINTABLE.test(appId))
    fields.push({ path: "appId", rule: "printable:1-200" });
  const attribution: Attribution = {};
  const raw = input.attribution ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    fields.push({ path: "attribution", rule: "type:object" });
  else {
    for (const key of ["siteContentUrl", "workbook", "view"] as const) {
      const value = (raw as Record<string, unknown>)[key];
      if (value === undefined || value === null || value === "") continue;
      if (typeof value !== "string" || value.length > 1000 || !PRINTABLE.test(value))
        fields.push({ path: `attribution.${key}`, rule: "printable:1-1000" });
      else attribution[key] = value;
    }
  }
  if (fields.length) throw invalid(fields);
  return { appId: appId as string, attribution };
}

/**
 * Verify app location: decides what the service knows about where the calling app runs.
 * It records the declared attribution only and proves nothing about the app's site.
 */
export function verifyAppLocation(_attribution: Attribution): { verified: boolean } {
  return { verified: false };
}

export type IdentityOptions = {
  db: Db;
  adapters: ReadonlyMap<string, DeploymentAdapter>;
  publicOrigin: string;
  signInLimitSeconds: number;
  clock: Clock;
  log: Log;
};

type SessionRow = {
  session_id: string;
  identity_id: string;
  deployment_id: string;
  site_id: string;
  user_id: string;
  user_name: string;
  site_content_url: string;
  trusted_site_id: string;
  verified_at: Date;
};

type AppSignInDelivery =
  | { mode: "popup" }
  | { mode: "loopback"; redirectUri: string; state: string };

export class IdentityService {
  readonly #db: Db;
  readonly #adapters: ReadonlyMap<string, DeploymentAdapter>;
  readonly #origin: string;
  readonly #limitMs: number;
  readonly #clock: Clock;
  readonly #log: Log;

  constructor(options: IdentityOptions) {
    this.#db = options.db;
    this.#adapters = options.adapters;
    this.#origin = options.publicOrigin;
    this.#limitMs = options.signInLimitSeconds * 1000;
    this.#clock = options.clock;
    this.#log = options.log;
  }

  get signInLimitMs(): number {
    return this.#limitMs;
  }

  deploymentIds(): string[] {
    return [...this.#adapters.keys()];
  }

  #now(): Date {
    return this.#clock.now();
  }

  #cutoff(): Date {
    return new Date(this.#now().getTime() - this.#limitMs);
  }

  #expiry(verifiedAt: Date): Date {
    return new Date(verifiedAt.getTime() + this.#limitMs);
  }

  get callbackUri(): string {
    return `${this.#origin}${TABLEAU_CALLBACK_PATH}`;
  }

  /** The client metadata document Tableau fetches to resolve the service's client ID. */
  clientMetadata(): ReturnType<typeof tableauClientMetadata> {
    return tableauClientMetadata(this.#origin);
  }

  // ---- Tableau sign-in ----

  /** Starts a Tableau sign-in for a page flow. `browserToken` goes in a cookie and must come back with the callback. */
  async beginTableauSignIn(input: {
    deploymentId: string;
    returnTo: string;
  }): Promise<{ authorizationUrl: URL; browserToken: string }> {
    const adapter = this.#adapters.get(input.deploymentId);
    if (!adapter) throw invalid([{ path: "deployment", rule: "known-deployment" }]);
    if (!isLocalPath(input.returnTo)) throw invalid([{ path: "returnTo", rule: "service-path" }]);
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken();
    const browserToken = randomToken();
    await this.#db
      .insertInto("sign_in_transactions")
      .values({
        state_hash: hashToken(state),
        browser_hash: hashToken(browserToken),
        deployment_id: adapter.deploymentId,
        pkce_verifier: verifier,
        nonce,
        return_to: input.returnTo,
        expires_at: new Date(this.#now().getTime() + TRANSACTION_SECONDS * 1000),
      })
      .execute();
    const authorizationUrl = adapter.authorizationUrl({
      state,
      nonce,
      codeChallenge: pkceChallenge(verifier),
      redirectUri: this.callbackUri,
    });
    return { authorizationUrl, browserToken };
  }

  /**
   * Completes a Tableau sign-in from the callback. Any failure ends the transaction with no partial session.
   * Returns the new sign-in cookie value and where the page flow continues.
   */
  async completeTableauSignIn(input: {
    query: URLSearchParams;
    browserToken: string | undefined;
    signal?: AbortSignal;
  }): Promise<{ cookie: string; returnTo: string; session: SignInSession }> {
    const state = input.query.get("state");
    if (!state)
      throw new ServiceError(400, "sign-in-transaction-invalid", "The sign-in link is not valid");
    const tx = await this.#db
      .deleteFrom("sign_in_transactions")
      .where("state_hash", "=", hashToken(state))
      .returningAll()
      .executeTakeFirst();
    if (!tx || tx.expires_at <= this.#now())
      throw new ServiceError(
        400,
        "sign-in-transaction-invalid",
        "The sign-in has expired; start again",
      );
    if (!input.browserToken || !sameSecret(hashToken(input.browserToken), tx.browser_hash))
      throw new ServiceError(
        400,
        "sign-in-transaction-invalid",
        "The sign-in started in another browser; start again",
      );
    const adapter = this.#adapters.get(tx.deployment_id);
    if (!adapter)
      throw new ServiceError(
        400,
        "sign-in-transaction-invalid",
        "The deployment is no longer configured",
      );
    const verified = await adapter.complete({
      callback: input.query,
      state,
      nonce: tx.nonce,
      verifier: tx.pkce_verifier,
      redirectUri: this.callbackUri,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const cookie = randomToken();
    const now = this.#now();
    const session = await transaction(this.#db, async (t) => {
      const site = await matchAndBindSite(
        t,
        adapter.deploymentId,
        verified.siteId,
        verified.siteContentUrl,
      );
      if (!site)
        throw new ServiceError(
          403,
          "site-not-trusted",
          `The Tableau site "${verified.siteContentUrl}" is not trusted by this service`,
        );
      const identity: Identity = {
        deploymentId: adapter.deploymentId,
        siteId: verified.siteId,
        userId: verified.userId,
      };
      const row = await t
        .insertInto("identities")
        .values({
          deployment_id: identity.deploymentId,
          site_id: identity.siteId,
          user_id: identity.userId,
          site_content_url: verified.siteContentUrl,
          user_name: verified.userName,
          last_verified_at: now,
        })
        .onConflict((oc) =>
          oc.columns(["deployment_id", "site_id", "user_id"]).doUpdateSet({
            site_content_url: verified.siteContentUrl,
            user_name: verified.userName,
            last_verified_at: now,
          }),
        )
        .returning("id")
        .executeTakeFirstOrThrow();
      await bindOperator(t, identity, verified.siteContentUrl, verified.userName);
      const created = await t
        .insertInto("sign_in_sessions")
        .values({
          cookie_hash: hashToken(cookie),
          identity_id: row.id,
          verified_at: now,
          expires_at: this.#expiry(now),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      return {
        id: created.id,
        identityId: row.id,
        identity,
        trustedSiteId: site.id,
        siteContentUrl: verified.siteContentUrl,
        userName: verified.userName,
        verifiedAt: now,
        expiresAt: this.#expiry(now),
      } satisfies SignInSession;
    });
    this.#log.info("tableau sign-in verified", {
      deploymentId: adapter.deploymentId,
      siteId: verified.siteId,
      userId: verified.userId,
    });
    return { cookie, returnTo: tx.return_to, session };
  }

  // ---- Sign-in sessions ----

  #sessionQuery(db: Queryable) {
    return db
      .selectFrom("sign_in_sessions as s")
      .innerJoin("identities as i", "i.id", "s.identity_id")
      .innerJoin("trusted_sites as t", (join) =>
        join
          .onRef("t.deployment_id", "=", "i.deployment_id")
          .onRef("t.site_id", "=", "i.site_id")
          .on("t.enabled", "=", true),
      )
      .select([
        "s.id as session_id",
        "i.id as identity_id",
        "i.deployment_id",
        "i.site_id",
        "i.user_id",
        "i.user_name",
        "i.site_content_url",
        "t.id as trusted_site_id",
        "s.verified_at",
      ])
      .where("s.verified_at", ">", this.#cutoff());
  }

  #toSession(row: SessionRow): SignInSession {
    return {
      id: row.session_id,
      identityId: row.identity_id,
      identity: { deploymentId: row.deployment_id, siteId: row.site_id, userId: row.user_id },
      trustedSiteId: row.trusted_site_id,
      siteContentUrl: row.site_content_url,
      userName: row.user_name,
      verifiedAt: row.verified_at,
      expiresAt: this.#expiry(row.verified_at),
    };
  }

  /** Reads the sign-in cookie. Valid while the last Tableau sign-in is younger than the limit and the site is trusted. */
  async readSignInSession(cookie: string | undefined): Promise<SignInSession | undefined> {
    if (!cookie) return undefined;
    const row = await this.#sessionQuery(this.#db)
      .where("s.cookie_hash", "=", hashToken(cookie))
      .executeTakeFirst();
    return row ? this.#toSession(row) : undefined;
  }

  async #sessionById(db: Queryable, id: string): Promise<SignInSession | undefined> {
    const row = await this.#sessionQuery(db).where("s.id", "=", id).executeTakeFirst();
    return row ? this.#toSession(row) : undefined;
  }

  // ---- App sign-in ----

  async startAppSignIn(input: {
    proofHash?: unknown;
    appId?: unknown;
    attribution?: unknown;
    loopback?: unknown;
  }): Promise<{ transactionId: string; expiresAt: Date }> {
    const declaration = readAppDeclaration(input);
    if (typeof input.proofHash !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.proofHash))
      throw invalid([{ path: "proofHash", rule: "format:sha256-base64url" }]);
    const loopback = readAppLoopback(input.loopback);
    const expiresAt = new Date(this.#now().getTime() + TRANSACTION_SECONDS * 1000);
    const row = await this.#db
      .insertInto("app_sign_ins")
      .values({
        proof_hash: input.proofHash,
        app_id: declaration.appId,
        attribution: JSON.stringify(declaration.attribution),
        redirect_uri: loopback?.redirectUri ?? null,
        client_state: loopback?.state ?? null,
        expires_at: expiresAt,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { transactionId: row.id, expiresAt };
  }

  /** How a pending app sign-in can deliver its completion code. */
  async appSignInDelivery(transactionId: string): Promise<AppSignInDelivery | undefined> {
    if (!isUuid(transactionId)) return undefined;
    const row = await this.#db
      .selectFrom("app_sign_ins")
      .select(["redirect_uri", "client_state"])
      .where("id", "=", transactionId)
      .where("redeemed_at", "is", null)
      .where("expires_at", ">", this.#now())
      .executeTakeFirst();
    if (!row) return undefined;
    return row.redirect_uri !== null && row.client_state !== null
      ? { mode: "loopback", redirectUri: row.redirect_uri, state: row.client_state }
      : { mode: "popup" };
  }

  /** Issues a completion code bound to the sign-in session and the transaction's delivery mode. */
  async issueCompletionCode(
    transactionId: string,
    session: SignInSession,
    mode: AppSignInDelivery["mode"] = "popup",
  ): Promise<string> {
    if (!isUuid(transactionId)) throw transactionInvalid();
    const code = randomToken();
    const updated = await this.#db
      .updateTable("app_sign_ins")
      .set({ code_hash: hashToken(code), sign_in_session_id: session.id })
      .where("id", "=", transactionId)
      .where("redirect_uri", mode === "popup" ? "is" : "is not", null)
      .where("redeemed_at", "is", null)
      .where("expires_at", ">", this.#now())
      .returning("id")
      .executeTakeFirst();
    if (!updated) throw transactionInvalid();
    return code;
  }

  /** Redeems a completion code with the proof that started the transaction, for a bearer and a restore token. */
  async redeemAppSignIn(
    transactionId: string,
    input: { code?: unknown; proof?: unknown },
  ): Promise<{ bearer: string; restoreToken: string; principal: Principal }> {
    if (!isUuid(transactionId) || typeof input.code !== "string" || typeof input.proof !== "string")
      throw transactionInvalid();
    const code = input.code;
    const proof = input.proof;
    return await transaction(this.#db, async (t) => {
      const tx = await t
        .selectFrom("app_sign_ins")
        .selectAll()
        .where("id", "=", transactionId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !tx ||
        tx.redeemed_at !== null ||
        tx.expires_at <= this.#now() ||
        !tx.code_hash ||
        !tx.sign_in_session_id ||
        !sameSecret(hashToken(code), tx.code_hash) ||
        !sameSecret(pkceChallenge(proof), tx.proof_hash)
      )
        throw transactionInvalid();
      await t
        .updateTable("app_sign_ins")
        .set({ redeemed_at: this.#now() })
        .where("id", "=", tx.id)
        .execute();
      const session = await this.#sessionById(t, tx.sign_in_session_id);
      if (!session) throw signInRequired();
      const restoreToken = randomToken();
      await t
        .insertInto("restore_tokens")
        .values({
          token_hash: hashToken(restoreToken),
          sign_in_session_id: session.id,
          expires_at: session.expiresAt,
        })
        .execute();
      const issued = await this.#issueAppSession(t, session, tx.app_id, tx.attribution);
      return { ...issued, restoreToken };
    });
  }

  /** Restores an app session from the restore cookie with no prompt. */
  async restore(
    restoreToken: string | undefined,
    input: { appId?: unknown; attribution?: unknown },
  ): Promise<{ bearer: string; principal: Principal }> {
    const declaration = readAppDeclaration(input);
    if (!restoreToken) throw signInRequired();
    return await transaction(this.#db, async (t) => {
      const token = await t
        .selectFrom("restore_tokens")
        .select("sign_in_session_id")
        .where("token_hash", "=", hashToken(restoreToken))
        .executeTakeFirst();
      if (!token) throw signInRequired();
      const session = await this.#sessionById(t, token.sign_in_session_id);
      if (!session) throw signInRequired();
      return await this.#issueAppSession(t, session, declaration.appId, declaration.attribution);
    });
  }

  async #issueAppSession(
    t: Tx,
    session: SignInSession,
    appId: string,
    attribution: Attribution,
  ): Promise<{ bearer: string; principal: Principal }> {
    const location = verifyAppLocation(attribution);
    const bearer = randomToken();
    const row = await t
      .insertInto("app_sessions")
      .values({
        bearer_hash: hashToken(bearer),
        kind: "app",
        identity_id: session.identityId,
        sign_in_session_id: session.id,
        app_id: appId,
        attribution: JSON.stringify(attribution),
        location: JSON.stringify(location),
        expires_at: session.expiresAt,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await this.#recordApp(t, appId, attribution, session);
    return {
      bearer,
      principal: {
        sessionId: row.id,
        kind: "app",
        identityId: session.identityId,
        identity: session.identity,
        trustedSiteId: session.trustedSiteId,
        siteContentUrl: session.siteContentUrl,
        userName: session.userName,
        appId,
        attribution,
        location,
        expiresAt: session.expiresAt,
      },
    };
  }

  async #recordApp(
    t: Tx,
    appId: string,
    attribution: Attribution,
    session: SignInSession,
  ): Promise<void> {
    const now = this.#now();
    const workbook = attribution.workbook ? [attribution.workbook] : [];
    await t
      .insertInto("apps")
      .values({
        app_id: appId,
        first_seen_at: now,
        last_seen_at: now,
        session_count: 1,
        site_ids: [session.trustedSiteId],
        workbooks: workbook,
      })
      .onConflict((oc) =>
        oc.column("app_id").doUpdateSet({
          last_seen_at: now,
          session_count: sql`apps.session_count + 1`,
          site_ids: sql`(select array(select distinct unnest(apps.site_ids || excluded.site_ids)))`,
          workbooks: sql`(select array(select distinct unnest(apps.workbooks || excluded.workbooks)))`,
        }),
      )
      .execute();
  }

  // ---- Bearers ----

  /** Resolves a service bearer. Sessions end at the sign-in limit, on revocation, and when their site stops being trusted. */
  async authenticate(bearer: string | undefined): Promise<Principal | undefined> {
    if (!bearer) return undefined;
    const row = await this.#sessionQuery(this.#db)
      .innerJoin("app_sessions as a", "a.sign_in_session_id", "s.id")
      .select([
        "a.id as app_session_id",
        "a.kind",
        "a.app_id",
        "a.attribution",
        "a.location",
        "a.last_seen_at",
      ])
      .where("a.bearer_hash", "=", hashToken(bearer))
      .executeTakeFirst();
    if (!row) return undefined;
    const session = this.#toSession(row);
    // Authoritative reads remain required; fresh activity observations need no UPDATE round trip.
    const now = this.#now();
    const cutoff = new Date(now.getTime() - 60_000);
    if (row.last_seen_at < cutoff) {
      try {
        await this.#db
          .updateTable("app_sessions")
          .set({ last_seen_at: now })
          .where("id", "=", row.app_session_id)
          // Another request may have observed the same old timestamp before this one committed.
          .where("last_seen_at", "<", cutoff)
          .execute();
      } catch {
        this.#log.warn("session activity observation failed", {
          errorCode: "activity-observation-failed",
        });
      }
    }
    return {
      sessionId: row.app_session_id,
      kind: row.kind,
      identityId: session.identityId,
      identity: session.identity,
      trustedSiteId: session.trustedSiteId,
      siteContentUrl: session.siteContentUrl,
      userName: session.userName,
      appId: row.app_id,
      attribution: row.attribution,
      location: row.location,
      expiresAt: session.expiresAt,
    };
  }

  /** Whether a session is still live: not expired, not revoked, and its site still trusted. */
  async sessionActive(sessionId: string): Promise<boolean> {
    if (!isUuid(sessionId)) return false;
    const row = await this.#sessionQuery(this.#db)
      .innerJoin("app_sessions as a", "a.sign_in_session_id", "s.id")
      .select("a.id as app_session_id")
      .where("a.id", "=", sessionId)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** An operator principal: an operator bearer whose identity is in the operators table now. */
  async authenticateOperator(bearer: string | undefined): Promise<Principal> {
    const principal = await this.authenticate(bearer);
    if (!principal) throw signInRequired();
    if (principal.kind !== "operator" || !(await isOperator(this.#db, principal.identity)))
      throw new ServiceError(403, "operator-required", "This needs an operator sign-in");
    return principal;
  }

  // ---- Operator sign-in ----

  /**
   * Starts an operator sign-in. Loopback mode is the CLI: the code goes to its 127.0.0.1 address.
   * Popup mode is a browser tool: the code is posted to the opener. Both redeem with the PKCE verifier.
   */
  async beginOperatorSignIn(input: {
    mode: "loopback" | "popup" | "console";
    redirectUri?: string | undefined;
    codeChallenge?: string | undefined;
    state?: string | undefined;
  }): Promise<string> {
    const fields = [];
    if (typeof input.codeChallenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge))
      fields.push({ path: "code_challenge", rule: "format:s256" });
    if (input.mode === "loopback" && !parseLoopbackRedirect(input.redirectUri))
      fields.push({ path: "redirect_uri", rule: "format:loopback-http" });
    if (
      input.state !== undefined &&
      (input.state.length > 200 || !/^[\x21-\x7e]*$/.test(input.state))
    )
      fields.push({ path: "state", rule: "max:200" });
    if (fields.length) throw invalid(fields);
    const row = await this.#db
      .insertInto("operator_sign_ins")
      .values({
        mode: input.mode,
        redirect_uri: input.mode === "loopback" ? (input.redirectUri as string) : null,
        code_challenge: input.codeChallenge as string,
        client_state: input.state ?? null,
        expires_at: new Date(this.#now().getTime() + TRANSACTION_SECONDS * 1000),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async operatorSignInMode(
    transactionId: string,
  ): Promise<"loopback" | "popup" | "console" | undefined> {
    if (!isUuid(transactionId)) return undefined;
    const row = await this.#db
      .selectFrom("operator_sign_ins")
      .select("mode")
      .where("id", "=", transactionId)
      .where("expires_at", ">", this.#now())
      .executeTakeFirst();
    return row?.mode;
  }

  /** Prepares the consent screen: the signed-in identity must be an operator. Returns a one-time consent token. */
  async prepareOperatorConsent(
    transactionId: string,
    session: SignInSession,
  ): Promise<{
    consent: string;
    mode: "loopback" | "popup" | "console";
    redirectUri: string | null;
  }> {
    if (!(await isOperator(this.#db, session.identity)))
      throw new ServiceError(
        403,
        "operator-required",
        "This Tableau user is not an operator of this service",
      );
    if (!isUuid(transactionId)) throw transactionInvalid();
    const consent = randomToken();
    const row = await this.#db
      .updateTable("operator_sign_ins")
      .set({ consent_hash: hashToken(consent), sign_in_session_id: session.id })
      .where("id", "=", transactionId)
      .where("redeemed_at", "is", null)
      .where("code_hash", "is", null)
      .where("expires_at", ">", this.#now())
      .returning(["mode", "redirect_uri"])
      .executeTakeFirst();
    if (!row) throw transactionInvalid();
    return { consent, mode: row.mode, redirectUri: row.redirect_uri };
  }

  /** The operator approved on the consent screen; issues the one-time code. */
  async approveOperatorSignIn(
    transactionId: string,
    consent: string | undefined,
    session: SignInSession,
  ): Promise<{
    code: string;
    mode: "loopback" | "popup" | "console";
    redirectUri: string | null;
    state: string | null;
  }> {
    if (!isUuid(transactionId) || !consent) throw transactionInvalid();
    if (!(await isOperator(this.#db, session.identity)))
      throw new ServiceError(
        403,
        "operator-required",
        "This Tableau user is not an operator of this service",
      );
    const code = randomToken();
    const row = await this.#db
      .updateTable("operator_sign_ins")
      .set({ code_hash: hashToken(code), consent_hash: null })
      .where("id", "=", transactionId)
      .where("consent_hash", "=", hashToken(consent))
      .where("sign_in_session_id", "=", session.id)
      .where("code_hash", "is", null)
      .where("redeemed_at", "is", null)
      .where("expires_at", ">", this.#now())
      .returning(["mode", "redirect_uri", "client_state"])
      .executeTakeFirst();
    if (!row) throw transactionInvalid();
    return { code, mode: row.mode, redirectUri: row.redirect_uri, state: row.client_state };
  }

  /** Redeems an operator code with its PKCE verifier for an operator bearer. */
  async redeemOperatorCode(input: {
    code?: unknown;
    verifier?: unknown;
  }): Promise<{ bearer: string; principal: Principal }> {
    if (typeof input.code !== "string" || typeof input.verifier !== "string")
      throw transactionInvalid();
    const code = input.code;
    const verifier = input.verifier;
    return await transaction(this.#db, async (t) => {
      const tx = await t
        .selectFrom("operator_sign_ins")
        .selectAll()
        .where("code_hash", "=", hashToken(code))
        .forUpdate()
        .executeTakeFirst();
      if (!tx || tx.redeemed_at !== null || tx.expires_at <= this.#now() || !tx.sign_in_session_id)
        throw transactionInvalid();
      if (!sameSecret(pkceChallenge(verifier), tx.code_challenge)) throw transactionInvalid();
      await t
        .updateTable("operator_sign_ins")
        .set({ redeemed_at: this.#now() })
        .where("id", "=", tx.id)
        .execute();
      const session = await this.#sessionById(t, tx.sign_in_session_id);
      if (!session) throw signInRequired();
      if (!(await isOperator(t, session.identity)))
        throw new ServiceError(
          403,
          "operator-required",
          "This Tableau user is not an operator of this service",
        );
      const bearer = randomToken();
      const row = await t
        .insertInto("app_sessions")
        .values({
          bearer_hash: hashToken(bearer),
          kind: "operator",
          identity_id: session.identityId,
          sign_in_session_id: session.id,
          app_id: null,
          attribution: "{}",
          location: JSON.stringify({ verified: false }),
          expires_at: session.expiresAt,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      return {
        bearer,
        principal: {
          sessionId: row.id,
          kind: "operator",
          identityId: session.identityId,
          identity: session.identity,
          trustedSiteId: session.trustedSiteId,
          siteContentUrl: session.siteContentUrl,
          userName: session.userName,
          appId: null,
          attribution: {},
          location: { verified: false },
          expiresAt: session.expiresAt,
        },
      };
    });
  }

  async endSession(sessionId: string): Promise<void> {
    await this.#db.deleteFrom("app_sessions").where("id", "=", sessionId).execute();
  }

  // ---- Revocation and registry ----

  /** Ends every session for an identity: sign-in sessions, restore cookies and bearers. */
  async revokeSessions(actor: string, identity: Identity): Promise<number> {
    return await transaction(this.#db, async (t) => {
      const deleted = await t
        .deleteFrom("sign_in_sessions")
        .where("identity_id", "in", (q) =>
          q
            .selectFrom("identities")
            .select("id")
            .where("deployment_id", "=", identity.deploymentId)
            .where("site_id", "=", identity.siteId)
            .where("user_id", "=", identity.userId),
        )
        .returning("id")
        .execute();
      await t
        .insertInto("audit")
        .values({
          actor,
          action: "identity.revoke-sessions",
          target: `${identity.deploymentId}:${identity.siteId}:${identity.userId}`,
          detail: JSON.stringify({ sessions: deleted.length }),
        })
        .execute();
      return deleted.length;
    });
  }

  async listApps(): Promise<
    {
      appId: string;
      firstSeenAt: Date;
      lastSeenAt: Date;
      sessionCount: number;
      sites: string[];
      workbooks: string[];
    }[]
  > {
    const rows = await this.#db
      .selectFrom("apps")
      .selectAll()
      .orderBy("last_seen_at", "desc")
      .execute();
    return rows.map((r) => ({
      appId: r.app_id,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      sessionCount: Number(r.session_count),
      sites: r.site_ids,
      workbooks: r.workbooks,
    }));
  }
}

function transactionInvalid(): ServiceError {
  return new ServiceError(
    400,
    "sign-in-transaction-invalid",
    "The sign-in is not valid or has expired; start again",
  );
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isLocalPath(value: string): boolean {
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    !/[\x00-\x1f]/.test(value)
  );
}

function readAppLoopback(value: unknown): { redirectUri: string; state: string } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid([{ path: "loopback", rule: "type:object" }]);
  const { redirectUri, state } = value as Record<string, unknown>;
  const target = parseLoopbackRedirect(typeof redirectUri === "string" ? redirectUri : undefined);
  if (!target) throw invalid([{ path: "loopback.redirectUri", rule: "format:loopback-http" }]);
  if (typeof state !== "string" || !/^[\x21-\x7e]{1,200}$/.test(state))
    throw invalid([{ path: "loopback.state", rule: "printable:1-200" }]);
  return { redirectUri: target.href, state };
}

function parseLoopbackRedirect(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      url.port !== "" &&
      !url.username &&
      !url.password &&
      !url.hash
    )
      return url;
  } catch {}
  return undefined;
}
