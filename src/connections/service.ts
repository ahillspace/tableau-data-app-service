import { sql } from "kysely";
import { isOperator } from "../identity/directory.ts";
import { actorOf, identityKey, type Principal, type SignInSession } from "../identity/types.ts";
import { writeAudit } from "../persistence/audit.ts";
import { type Db, transaction } from "../persistence/database.ts";
import type { Clock } from "../platform/clock.ts";
import { invalid, notFound, ServiceError } from "../platform/errors.ts";
import type { Log } from "../platform/log.ts";
import type { Outbound } from "../platform/outbound.ts";
import { hashToken, pkceChallenge, randomToken } from "../platform/secrets.ts";
import { definitionSecretRecordId } from "../sealing/reseal.ts";
import type { Sealer } from "../sealing/sealer.ts";
import { type DefinitionStore, definitionFromRow } from "./definitions.ts";
import { placeable } from "./placement.ts";
import { readTokens, tokenRequest } from "./protocol.ts";
import type { Account, PresetContext, ProviderType } from "./provider-types.ts";
import {
  leaseFor,
  lockDefinition,
  openCredential,
  readDefinitionSecret,
  replaceConnection,
  SECRET_PURPOSE,
  sealCredential,
} from "./store.ts";
import type {
  ConnectionDefinition,
  CredentialLease,
  LinkField,
  StoredCredential,
} from "./types.ts";

/** A credential this close to expiry is refreshed before use. */
const REFRESH_SKEW_MS = 60_000;
/** A refresh holds its row lock for at most this long. */
const REFRESH_TIMEOUT_MS = 30_000;
const CONNECT_TRANSACTION_MS = 10 * 60_000;
const SECRET_LINK_MS = 15 * 60_000;
const ACCOUNT_LOOKUP_MS = 5_000;
const MAX_SECRET_LENGTH = 64 * 1024;

export type ConnectionStatus = "connected" | "needs-authorization" | "not-connected";

/** What a Data App learns about a definition it may use. */
export type AppDefinition = {
  id: string;
  displayName: string;
  type: string;
  ownership: "shared" | "personal";
  /** How the caller can set the definition up, if at all. */
  setup: { oauth: boolean; credential: boolean };
  status: ConnectionStatus;
  account: { id: string; name: string | null } | null;
  authorizedAt: string | null;
  scopes: string[];
};

export type ConnectionRecord = {
  id: string;
  definitionId: string;
  generation: number;
  owner: string | null;
  status: "connected" | "needs-authorization" | "disconnected";
  account: { id: string; name: string | null } | null;
  scopes: string[];
  authorizedAt: string;
  credentialExpiresAt: string | null;
  disconnectedAt: string | null;
  disconnectReason: string | null;
};

export type ConnectionsOptions = {
  db: Db;
  definitions: DefinitionStore;
  sealer: Sealer;
  outbound: Outbound;
  publicOrigin: string;
  clock: Clock;
  log: Log;
};

/** Who a checkout is for: an app session, or the owner a Job was admitted for. */
export type CheckoutCaller = Pick<Principal, "identityId" | "trustedSiteId">;

function checkoutError(code: string): ServiceError {
  switch (code) {
    case "definition-not-found":
      return new ServiceError(404, code, "No such definition", { upstream: "not-sent" });
    case "definition-disabled":
      return new ServiceError(403, code, "The definition is disabled", { upstream: "not-sent" });
    case "not-in-audience":
      return new ServiceError(403, code, "Your Tableau site cannot use this definition", {
        upstream: "not-sent",
      });
    case "not-connected":
      return new ServiceError(403, code, "There is no connection for this definition yet", {
        upstream: "not-sent",
      });
    case "needs-authorization":
      return new ServiceError(403, code, "The connection needs to be authorized again", {
        upstream: "not-sent",
      });
    default:
      return new ServiceError(403, code, "Checkout failed", { upstream: "not-sent" });
  }
}

/**
 * Connections: checkout, refresh, OAuth connect, static credentials, secret links and disconnect.
 * Every credential is sealed to its connection ID and used only with the generation that issued it.
 */
export class ConnectionService {
  readonly #db: Db;
  readonly #definitions: DefinitionStore;
  readonly #sealer: Sealer;
  readonly #outbound: Outbound;
  readonly #origin: string;
  readonly #clock: Clock;
  readonly #log: Log;

  constructor(options: ConnectionsOptions) {
    this.#db = options.db;
    this.#definitions = options.definitions;
    this.#sealer = options.sealer;
    this.#outbound = options.outbound;
    this.#origin = options.publicOrigin;
    this.#clock = options.clock;
    this.#log = options.log;
  }

  get callbackUri(): string {
    return `${this.#origin}/v1/oauth/callback`;
  }

  get definitions(): DefinitionStore {
    return this.#definitions;
  }

  #type(definition: ConnectionDefinition): ProviderType {
    const type = this.#definitions.types.get(definition.type);
    if (!type)
      throw new ServiceError(
        503,
        "provider-type-unavailable",
        `Provider type ${definition.type} is not installed`,
      );
    return type;
  }

  /** The fetch and destination rules preset code uses for a definition. */
  presetContext(definition: ConnectionDefinition, signal: AbortSignal): PresetContext {
    return { fetch: this.#outbound.fetcher(definition.privateHosts), signal };
  }

  async #liveDefinition(id: string): Promise<ConnectionDefinition> {
    const definition = await this.#definitions.get(id);
    if (!definition) throw checkoutError("definition-not-found");
    if (!definition.enabled || definition.retired) throw checkoutError("definition-disabled");
    return definition;
  }

  // ---- Checkout ----

  /**
   * Returns a credential lease for one request. A personal checkout returns only the caller's own
   * connection; a shared checkout returns the shared connection. Nothing falls back to anything else.
   */
  async checkout(
    principal: CheckoutCaller,
    definitionId: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<CredentialLease> {
    // One query rechecks the definition's enabled flag, generation and audience and reads the credential.
    const rows = await this.#db
      .selectFrom("definitions as d")
      .leftJoin("connections as c", (join) =>
        join
          .onRef("c.definition_id", "=", "d.id")
          .onRef("c.generation", "=", "d.generation")
          .on("c.status", "<>", "disconnected")
          .on((eb) =>
            eb.or([
              eb("c.owner_identity_id", "is", null),
              eb("c.owner_identity_id", "=", principal.identityId),
            ]),
          ),
      )
      .select([
        "d.generation",
        "d.enabled",
        "d.retired",
        sql<boolean>`d.audience ? ${principal.trustedSiteId}::text`.as("in_audience"),
        "c.id as connection_id",
        "c.owner_identity_id",
        "c.status",
        "c.sealed",
        "c.authorized_at",
      ])
      .where("d.id", "=", definitionId)
      .execute();
    const first = rows[0];
    if (!first) throw checkoutError("definition-not-found");
    let definition = (await this.#definitions.current()).get(definitionId);
    // A cache older than the row reloads once; the row is the authority either way.
    if (definition?.generation !== first.generation)
      definition = (await this.#definitions.current({ force: true })).get(definitionId);
    if (!definition || definition.generation !== first.generation)
      throw new ServiceError(503, "definition-changing", "The definition is changing; try again", {
        upstream: "not-sent",
      });
    if (!first.enabled || first.retired) throw checkoutError("definition-disabled");
    if (!first.in_audience) throw checkoutError("not-in-audience");
    const shared = definition.ownership === "shared";
    const row = rows.find(
      (r) =>
        r.connection_id !== null &&
        (shared ? r.owner_identity_id === null : r.owner_identity_id === principal.identityId),
    ) ?? { ...first, connection_id: null, sealed: null, authorized_at: null, status: null };
    {
      const type = this.#type(definition);
      if (type.credentialless) return leaseFor(definition, null, null);
      if (!row.connection_id || !row.sealed || !row.authorized_at)
        throw checkoutError("not-connected");
      if (row.status === "needs-authorization") throw checkoutError("needs-authorization");
      const now = this.#clock.now();
      if (
        definition.reauthorizationInterval !== undefined &&
        row.authorized_at.getTime() + definition.reauthorizationInterval * 1000 <= now.getTime()
      ) {
        await this.#markNeedsAuthorization(row.connection_id, "reauthorization-interval");
        throw checkoutError("needs-authorization");
      }
      let credential = openCredential(this.#sealer, row.connection_id, row.sealed);
      const expiresAt = credential.expiresAt ? Date.parse(credential.expiresAt) : undefined;
      if (expiresAt !== undefined && expiresAt - REFRESH_SKEW_MS <= now.getTime()) {
        if (credential.refreshToken && type.oauth !== "none" && definition.tokenEndpoint)
          credential = await this.refresh(definition, row.connection_id, signal);
        else if (expiresAt <= now.getTime()) {
          await this.#markNeedsAuthorization(row.connection_id, "expired");
          throw checkoutError("needs-authorization");
        }
      }
      return leaseFor(definition, row.connection_id, credential);
    }
  }

  async #markNeedsAuthorization(connectionId: string, reason: string): Promise<void> {
    const now = this.#clock.now();
    await this.#db
      .updateTable("connections")
      .set({ status: "needs-authorization", disconnect_reason: reason, updated_at: now })
      .where("id", "=", connectionId)
      .where("status", "=", "connected")
      .execute();
  }

  // ---- Refresh ----

  /**
   * Refreshes under a row lock so concurrent requests on any replica refresh once.
   * The new credential is written before the lock is released; the authorization time never moves.
   */
  async refresh(
    definition: ConnectionDefinition,
    connectionId: string,
    signal: AbortSignal,
  ): Promise<StoredCredential> {
    const type = this.#type(definition);
    const outcome = await transaction(
      this.#db,
      async (tx): Promise<{ credential: StoredCredential } | { rejected: true }> => {
        const budget = `${REFRESH_TIMEOUT_MS + 15_000}ms`;
        await sql`select set_config('lock_timeout', ${budget}, true), set_config('idle_in_transaction_session_timeout', ${budget}, true)`.execute(
          tx,
        );
        const row = await tx
          .selectFrom("connections")
          .select(["status", "sealed", "generation"])
          .where("id", "=", connectionId)
          .forUpdate()
          .executeTakeFirst();
        if (
          !row ||
          row.status === "disconnected" ||
          !row.sealed ||
          row.generation !== definition.generation
        )
          throw checkoutError("not-connected");
        if (row.status === "needs-authorization") throw checkoutError("needs-authorization");
        const current = openCredential(this.#sealer, connectionId, row.sealed);
        const now = this.#clock.now();
        if (current.expiresAt && Date.parse(current.expiresAt) - REFRESH_SKEW_MS > now.getTime())
          return { credential: current };
        if (!current.refreshToken) throw checkoutError("needs-authorization");
        const secret = await readDefinitionSecret(tx, this.#sealer, definition.id, "clientSecret");
        let response: { status: number; body: unknown };
        try {
          response = await tokenRequest(
            this.#outbound,
            definition,
            secret,
            { grant_type: "refresh_token", refresh_token: current.refreshToken },
            AbortSignal.any([signal, AbortSignal.timeout(REFRESH_TIMEOUT_MS)]),
          );
        } catch (error) {
          // The provider may have rotated the refresh token; keep the stored credential and let the caller retry.
          this.#log.warn("refresh outcome unknown", {
            definitionId: definition.id,
            connectionId,
            error,
          });
          throw new ServiceError(
            502,
            "refresh-uncertain",
            "The credential refresh did not complete; try again",
            { upstream: "not-sent", cause: error },
          );
        }
        const reading = readTokens(type, definition, response, true, now);
        if (reading.kind === "error") {
          if (reading.rejectsGrant) {
            // Committed with the transaction; the checkout error is raised once it has.
            await tx
              .updateTable("connections")
              .set({
                status: "needs-authorization",
                disconnect_reason: "refresh-rejected",
                updated_at: now,
              })
              .where("id", "=", connectionId)
              .execute();
            this.#log.info("refresh rejected", {
              definitionId: definition.id,
              connectionId,
              error: reading.error,
            });
            return { rejected: true as const };
          }
          if (reading.definitive)
            throw new ServiceError(
              502,
              "refresh-failed",
              `The provider refused the refresh (${reading.error})`,
              {
                upstream: "not-sent",
              },
            );
          this.#log.warn("refresh outcome unknown", {
            definitionId: definition.id,
            connectionId,
            error: reading.error,
          });
          throw new ServiceError(
            502,
            "refresh-uncertain",
            "The credential refresh did not complete; try again",
            {
              upstream: "not-sent",
            },
          );
        }
        const next: StoredCredential = {
          ...reading.credential,
          ...(reading.credential.refreshToken ? {} : { refreshToken: current.refreshToken }),
        };
        await tx
          .updateTable("connections")
          .set({
            sealed: JSON.stringify(sealCredential(this.#sealer, connectionId, next)),
            credential_expires_at: next.expiresAt ? new Date(next.expiresAt) : null,
            updated_at: now,
            ...(reading.scopes.length ? { scopes: JSON.stringify(reading.scopes) } : {}),
          })
          .where("id", "=", connectionId)
          .execute();
        return { credential: next };
      },
    );
    if ("rejected" in outcome) throw checkoutError("needs-authorization");
    return outcome.credential;
  }

  // ---- Definitions for apps ----

  /** Definitions the caller's site may use, with ownership and the caller's connection status. */
  async listForApp(principal: Principal): Promise<AppDefinition[]> {
    const all = [...(await this.#definitions.current()).values()].filter(
      (d) => d.enabled && !d.retired && d.audience.includes(principal.trustedSiteId),
    );
    if (!all.length) return [];
    const rows = await this.#db
      .selectFrom("connections")
      .select([
        "definition_id",
        "generation",
        "owner_identity_id",
        "status",
        "account",
        "account_name",
        "authorized_at",
        "scopes",
      ])
      .where(
        "definition_id",
        "in",
        all.map((d) => d.id),
      )
      .where("status", "<>", "disconnected")
      .where((eb) =>
        eb.or([
          eb("owner_identity_id", "is", null),
          eb("owner_identity_id", "=", principal.identityId),
        ]),
      )
      .execute();
    const now = this.#clock.now().getTime();
    return all
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((d) => {
        const type = this.#definitions.types.get(d.type);
        const shared = d.ownership === "shared";
        const row = rows.find(
          (r) =>
            r.definition_id === d.id &&
            r.generation === d.generation &&
            (shared ? r.owner_identity_id === null : r.owner_identity_id === principal.identityId),
        );
        let status: ConnectionStatus = "not-connected";
        if (type?.credentialless) status = "connected";
        else if (row) {
          const lapsed =
            d.reauthorizationInterval !== undefined &&
            row.authorized_at.getTime() + d.reauthorizationInterval * 1000 <= now;
          status = row.status === "connected" && !lapsed ? "connected" : "needs-authorization";
        }
        return {
          id: d.id,
          displayName: d.displayName,
          type: d.type,
          ownership: d.ownership,
          setup: {
            oauth:
              !shared && type !== undefined && type.oauth !== "none" && d.clientId !== undefined,
            credential: !shared && type?.staticCredential === true,
          },
          status,
          account: row?.account ? { id: row.account, name: row.account_name } : null,
          authorizedAt: row ? row.authorized_at.toISOString() : null,
          scopes: row?.scopes ?? [],
        };
      });
  }

  // ---- OAuth connect ----

  /**
   * Starts an OAuth connect. Apps connect personal definitions for themselves; operators connect shared ones.
   * The returned transaction opens on the connect page, which requires the same identity's sign-in cookie.
   */
  async startConnect(
    principal: Principal,
    definitionId: string,
    mode: "personal" | "shared",
  ): Promise<{ transactionId: string; url: string; expiresAt: Date }> {
    const definition = await this.#liveDefinition(definitionId);
    if (definition.ownership !== mode)
      throw new ServiceError(
        409,
        mode === "personal" ? "shared-definition" : "personal-definition",
        mode === "personal"
          ? "A shared definition is connected by an operator"
          : "Each viewer connects a personal definition themselves",
      );
    if (mode === "personal" && !definition.audience.includes(principal.trustedSiteId))
      throw checkoutError("not-in-audience");
    const type = this.#type(definition);
    if (
      type.oauth === "none" ||
      !definition.clientId ||
      !definition.authorizationEndpoint ||
      !definition.tokenEndpoint
    )
      throw new ServiceError(
        409,
        "oauth-not-supported",
        "This definition does not connect through OAuth",
      );
    const expiresAt = new Date(this.#clock.now().getTime() + CONNECT_TRANSACTION_MS);
    const row = await this.#db
      .insertInto("connect_transactions")
      .values({
        definition_id: definition.id,
        generation: definition.generation,
        identity_id: principal.identityId,
        shared: mode === "shared",
        expires_at: expiresAt,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { transactionId: row.id, url: `${this.#origin}/connect/${row.id}`, expiresAt };
  }

  async #pendingTransaction(transactionId: string) {
    if (!isUuid(transactionId)) throw connectInvalid();
    const tx = await this.#db
      .selectFrom("connect_transactions")
      .selectAll()
      .where("id", "=", transactionId)
      .executeTakeFirst();
    if (!tx || tx.status !== "pending" || tx.expires_at <= this.#clock.now())
      throw connectInvalid();
    return tx;
  }

  /** The connect page: checks the sign-in identity matches the transaction, then returns the provider URL. */
  async beginConnect(transactionId: string, session: SignInSession): Promise<URL> {
    const tx = await this.#pendingTransaction(transactionId);
    if (tx.identity_id !== session.identityId) throw identityMismatch();
    if (tx.shared && !(await isOperator(this.#db, session.identity)))
      throw new ServiceError(
        403,
        "operator-required",
        "Connecting a shared definition needs an operator",
      );
    const definition = await this.#definitions.get(tx.definition_id);
    if (
      !definition ||
      definition.generation !== tx.generation ||
      !definition.enabled ||
      definition.retired
    ) {
      await this.#failTransaction(tx.id, "definition-changed");
      throw definitionChanged();
    }
    const type = this.#type(definition);
    const state = randomToken();
    const verifier = randomToken();
    await this.#db
      .updateTable("connect_transactions")
      .set({ state_hash: hashToken(state), pkce_verifier: verifier, started: true })
      .where("id", "=", tx.id)
      .where("status", "=", "pending")
      .execute();
    const url = new URL(definition.authorizationEndpoint as string);
    const params = url.searchParams;
    params.set("response_type", "code");
    params.set("client_id", definition.clientId as string);
    params.set("redirect_uri", this.callbackUri);
    params.set("state", state);
    params.set("code_challenge", pkceChallenge(verifier));
    params.set("code_challenge_method", "S256");
    const extra = type.authorizationParameters
      ? type.authorizationParameters(definition)
      : definition.scopes.length
        ? { scope: definition.scopes.join(" ") }
        : {};
    for (const [name, value] of Object.entries(extra)) params.set(name, value);
    return url;
  }

  /**
   * The one OAuth callback, keyed by `state`. The browser must still hold the sign-in cookie of the
   * transaction's identity, so a provider account is attached only to the person who started the connect.
   */
  async completeConnect(input: {
    query: URLSearchParams;
    session: SignInSession | undefined;
    signal?: AbortSignal;
  }): Promise<{ transactionId: string; definitionId: string }> {
    const state = input.query.get("state");
    if (!state) throw connectInvalid();
    const now = this.#clock.now();
    const tx = await this.#db
      .updateTable("connect_transactions")
      .set({ state_hash: null })
      .where("state_hash", "=", hashToken(state))
      .returningAll()
      .executeTakeFirst();
    if (tx?.status === "failed" && tx.failure === "definition-changed") throw definitionChanged();
    if (!tx || tx.status !== "pending" || tx.expires_at <= now || !tx.pkce_verifier)
      throw connectInvalid();
    if (!input.session || input.session.identityId !== tx.identity_id) {
      await this.#failTransaction(tx.id, "identity-mismatch");
      throw identityMismatch();
    }
    const fail = async (code: string, error: ServiceError): Promise<never> => {
      await this.#failTransaction(tx.id, code);
      throw error;
    };
    const providerError = input.query.get("error");
    if (providerError) {
      const named = /^[\x21-\x7e]{1,100}$/.test(providerError) ? providerError : "error";
      return await fail(
        "authorization-denied",
        new ServiceError(
          400,
          "authorization-denied",
          `The provider did not authorize the connection (${named})`,
        ),
      );
    }
    const code = input.query.get("code");
    if (!code)
      return await fail(
        "authorization-invalid",
        new ServiceError(
          400,
          "authorization-invalid",
          "The provider returned no authorization code",
        ),
      );
    const definition = await this.#definitions.get(tx.definition_id);
    if (
      !definition ||
      definition.generation !== tx.generation ||
      !definition.enabled ||
      definition.retired
    )
      return await fail("definition-changed", definitionChanged());
    const type = this.#type(definition);
    const secret = await readDefinitionSecret(
      this.#db,
      this.#sealer,
      definition.id,
      "clientSecret",
    );
    let response: { status: number; body: unknown };
    try {
      response = await tokenRequest(
        this.#outbound,
        definition,
        secret,
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: this.callbackUri,
          code_verifier: tx.pkce_verifier,
        },
        input.signal ?? AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      );
    } catch (error) {
      const failure =
        error instanceof ServiceError
          ? error
          : new ServiceError(
              502,
              "upstream-interrupted",
              "The token endpoint could not be reached",
            );
      return await fail("token-request-failed", failure);
    }
    const reading = readTokens(type, definition, response, false, now);
    if (reading.kind === "error")
      return await fail(
        "token-request-failed",
        new ServiceError(
          502,
          "token-request-failed",
          `The provider refused the token request (${reading.error})`,
        ),
      );
    await transaction(this.#db, async (t) => {
      const live = await lockDefinition(t, definition.id);
      if (!live || !live.enabled || live.generation !== tx.generation) throw definitionChanged();
      // Operator authority is checked again, and held, where the shared credential is committed,
      // so an operator removed during the provider's consent screen cannot finish the connect.
      if (
        tx.shared &&
        !(await isOperator(t, (input.session as SignInSession).identity, { hold: true }))
      )
        throw operatorRequired();
      await replaceConnection(t, this.#sealer, {
        definition,
        ownerIdentityId: tx.shared ? null : tx.identity_id,
        credential: reading.credential,
        account: reading.account,
        scopes: reading.scopes.length ? reading.scopes : definition.scopes,
        now: this.#clock.now(),
      });
      await t
        .updateTable("connect_transactions")
        .set({ status: "connected", pkce_verifier: null })
        .where("id", "=", tx.id)
        .execute();
      if (tx.shared)
        await writeAudit(t, {
          actor: `operator:${identityKey(input.session?.identity as SignInSession["identity"])}`,
          action: "connection.connect",
          target: definition.id,
        });
    }).catch(async (error: unknown) => {
      if (
        error instanceof ServiceError &&
        (error.code === "definition-changed" || error.code === "operator-required")
      )
        await this.#failTransaction(tx.id, error.code);
      throw error;
    });
    return { transactionId: tx.id, definitionId: definition.id };
  }

  async #failTransaction(id: string, failure: string): Promise<void> {
    await this.#db
      .updateTable("connect_transactions")
      .set({ status: "failed", failure, state_hash: null, pkce_verifier: null })
      .where("id", "=", id)
      .where("status", "=", "pending")
      .execute();
  }

  // ---- Static credentials ----

  /** Stores a personal static credential as given. It is sealed and never returned. */
  async setPersonalCredential(
    principal: Principal,
    definitionId: string,
    value: unknown,
  ): Promise<AppDefinition | undefined> {
    const definition = await this.#liveDefinition(definitionId);
    if (definition.ownership !== "personal")
      throw new ServiceError(
        409,
        "shared-definition",
        "A shared credential is entered by an operator through a secret link",
      );
    if (!definition.audience.includes(principal.trustedSiteId))
      throw checkoutError("not-in-audience");
    await this.#storeStatic(definition, principal.identityId, value, actorOf(principal));
    return (await this.listForApp(principal)).find((d) => d.id === definitionId);
  }

  async #storeStatic(
    definition: ConnectionDefinition,
    ownerIdentityId: string | null,
    value: unknown,
    actor: string,
  ): Promise<void> {
    const type = this.#type(definition);
    if (!type.staticCredential)
      throw new ServiceError(
        409,
        "credential-not-supported",
        "This definition does not take a static credential",
      );
    if (typeof value !== "string" || value.length < 1 || value.length > MAX_SECRET_LENGTH)
      throw invalid([{ path: "credential", rule: `string:1-${MAX_SECRET_LENGTH}` }]);
    if (!placeable(definition.credentialPlacement, value))
      throw invalid([{ path: "credential", rule: "header-safe" }]);
    const credential: StoredCredential = { accessToken: value };
    const id = await transaction(this.#db, async (tx) => {
      const live = await lockDefinition(tx, definition.id);
      if (!live || !live.enabled || live.generation !== definition.generation)
        throw definitionChanged();
      const id = await replaceConnection(tx, this.#sealer, {
        definition,
        ownerIdentityId,
        credential,
        account: null,
        scopes: [],
        now: this.#clock.now(),
      });
      if (ownerIdentityId === null)
        await writeAudit(tx, { actor, action: "connection.credential", target: definition.id });
      return id;
    });
    if (type.describeAccount) {
      // The lookup only names the account for display; it never blocks or undoes storing the credential.
      const lease = leaseFor(definition, id, credential);
      const account = await type
        .describeAccount(
          lease,
          this.presetContext(definition, AbortSignal.timeout(ACCOUNT_LOOKUP_MS)),
        )
        .catch((error: unknown) => {
          this.#log.info("account lookup failed", { definitionId: definition.id, error });
          return null;
        });
      if (account) await this.#recordAccount(id, account);
    }
  }

  async #recordAccount(connectionId: string, account: Account): Promise<void> {
    await this.#db
      .updateTable("connections")
      .set({ account: account.id, account_name: account.name })
      .where("id", "=", connectionId)
      .where("status", "<>", "disconnected")
      .execute();
  }

  // ---- Secret links ----

  /** Creates a one-time link to the service's secret entry page for a definition field. */
  async createSecretLink(
    operator: Principal,
    definitionId: string,
    field: unknown,
  ): Promise<{ url: string; expiresAt: Date; field: LinkField }> {
    const row = await this.#db
      .selectFrom("definitions")
      .selectAll()
      .where("id", "=", definitionId)
      .executeTakeFirst();
    if (!row) throw notFound("definition-not-found", "No such definition");
    if (row.retired)
      throw new ServiceError(409, "definition-retired", "A retired definition cannot change");
    const definition = (await this.#definitions.current({ force: true })).get(
      definitionId,
    ) as ConnectionDefinition;
    const type = this.#type(definition);
    if (field !== "clientSecret" && field !== "signingSecret" && field !== "credential")
      throw invalid([{ path: "field", rule: "one-of:clientSecret|signingSecret|credential" }]);
    if (field === "clientSecret" && (type.oauth === "none" || !definition.clientId))
      throw invalid([{ path: "field", rule: "definition-has-no-oauth-client" }]);
    if (field === "signingSecret" && !type.eventSource)
      throw invalid([{ path: "field", rule: "type-has-no-event-source" }]);
    if (field === "credential" && (!type.staticCredential || definition.ownership !== "shared"))
      throw invalid([{ path: "field", rule: "shared-static-definition" }]);
    const token = randomToken();
    const expiresAt = new Date(this.#clock.now().getTime() + SECRET_LINK_MS);
    await transaction(this.#db, async (tx) => {
      await tx
        .insertInto("secret_links")
        .values({
          token_hash: hashToken(token),
          definition_id: definitionId,
          generation: definition.generation,
          field,
          created_by: actorOf(operator),
          expires_at: expiresAt,
        })
        .execute();
      await writeAudit(tx, {
        actor: actorOf(operator),
        action: "secret-link.create",
        target: definitionId,
        detail: { field },
      });
    });
    return { url: `${this.#origin}/secret/${token}`, expiresAt, field };
  }

  async #operatorSession(session: SignInSession | undefined): Promise<SignInSession> {
    if (!session)
      throw new ServiceError(401, "sign-in-required", "Sign in with Tableau to continue");
    if (!(await isOperator(this.#db, session.identity))) throw operatorRequired();
    return session;
  }

  /** What the secret page shows: the definition and field. Never a value. */
  async readSecretLink(
    token: string,
    session: SignInSession | undefined,
  ): Promise<{ definitionId: string; displayName: string; field: LinkField }> {
    await this.#operatorSession(session);
    const link = await this.#db
      .selectFrom("secret_links as l")
      .innerJoin("definitions as d", "d.id", "l.definition_id")
      .select(["l.definition_id", "l.field", "l.expires_at", "l.used_at", "d.display_name"])
      .where("l.token_hash", "=", hashToken(token))
      .executeTakeFirst();
    if (!link || link.used_at || link.expires_at <= this.#clock.now()) throw secretLinkInvalid();
    return { definitionId: link.definition_id, displayName: link.display_name, field: link.field };
  }

  /** Seals the value from the secret page and spends the link. */
  async submitSecret(
    token: string,
    session: SignInSession | undefined,
    value: unknown,
  ): Promise<{ definitionId: string; field: LinkField }> {
    const operator = await this.#operatorSession(session);
    const actor = `operator:${identityKey(operator.identity)}`;
    if (typeof value !== "string" || value.length < 1 || value.length > MAX_SECRET_LENGTH)
      throw invalid([{ path: "value", rule: `string:1-${MAX_SECRET_LENGTH}` }]);
    const now = this.#clock.now();
    const link = await this.#db
      .updateTable("secret_links")
      .set({ used_at: now })
      .where("token_hash", "=", hashToken(token))
      .where("used_at", "is", null)
      .where("expires_at", ">", now)
      .returning(["definition_id", "generation", "field"])
      .executeTakeFirst();
    if (!link) throw secretLinkInvalid();
    // A link is good only for the generation it was created for. The shared-credential path
    // stores under the same generation check, made again under the definition lock.
    if (link.field === "credential") {
      const definition = await this.#liveDefinition(link.definition_id);
      if (definition.generation !== link.generation || definition.ownership !== "shared")
        throw definitionChanged();
      await this.#storeStatic(definition, null, value, actor);
    } else {
      const field = link.field;
      await transaction(this.#db, async (tx) => {
        const live = await lockDefinition(tx, link.definition_id);
        if (!live)
          throw new ServiceError(409, "definition-retired", "A retired definition cannot change");
        if (live.generation !== link.generation) throw definitionChanged();
        const sealed = this.#sealer.seal(
          SECRET_PURPOSE[field],
          definitionSecretRecordId(link.definition_id, field),
          value,
        );
        await tx
          .insertInto("definition_secrets")
          .values({
            definition_id: link.definition_id,
            field,
            sealed: JSON.stringify(sealed),
            set_at: now,
          })
          .onConflict((oc) =>
            oc
              .columns(["definition_id", "field"])
              .doUpdateSet({ sealed: JSON.stringify(sealed), set_at: now }),
          )
          .execute();
        await writeAudit(tx, {
          actor,
          action: "definition.secret",
          target: link.definition_id,
          detail: { field },
        });
      });
    }
    return { definitionId: link.definition_id, field: link.field };
  }

  /** The sealed signing secret for an event source, if set. */
  async signingSecret(definitionId: string): Promise<string | undefined> {
    return await readDefinitionSecret(this.#db, this.#sealer, definitionId, "signingSecret");
  }

  // ---- Disconnect ----

  /** Disconnects the caller's own personal connection. */
  async disconnectOwn(principal: Principal, definitionId: string): Promise<boolean> {
    const definition = await this.#definitions.get(definitionId);
    if (!definition) throw checkoutError("definition-not-found");
    if (definition.ownership !== "personal")
      throw new ServiceError(
        409,
        "shared-definition",
        "A shared connection is disconnected by an operator",
      );
    const row = await this.#db
      .selectFrom("connections")
      .select("id")
      .where("definition_id", "=", definitionId)
      .where("owner_identity_id", "=", principal.identityId)
      .where("status", "<>", "disconnected")
      .executeTakeFirst();
    if (!row) return false;
    return await this.#disconnect(row.id, "owner", actorOf(principal));
  }

  /** Disconnects any connection. */
  async disconnectAny(operator: Principal, connectionId: string): Promise<boolean> {
    if (!isUuid(connectionId)) throw notFound("connection-not-found", "No such connection");
    const row = await this.#db
      .selectFrom("connections")
      .select("id")
      .where("id", "=", connectionId)
      .executeTakeFirst();
    if (!row) throw notFound("connection-not-found", "No such connection");
    return await this.#disconnect(connectionId, "operator", actorOf(operator));
  }

  /** Deletes the credential, then asks the provider to revoke the grant. A failed revocation is recorded. */
  async #disconnect(connectionId: string, reason: string, actor: string): Promise<boolean> {
    const now = this.#clock.now();
    const ended = await transaction(this.#db, async (tx) => {
      const row = await tx
        .selectFrom("connections")
        .select(["definition_id", "generation", "sealed", "status", "owner_identity_id"])
        .where("id", "=", connectionId)
        .forUpdate()
        .executeTakeFirst();
      if (!row || row.status === "disconnected" || !row.sealed) return undefined;
      // Revocation uses the definition the credential was issued under, read in this transaction,
      // never whatever the definition becomes afterwards.
      const issuedUnder = await tx
        .selectFrom("definitions")
        .selectAll()
        .where("id", "=", row.definition_id)
        .where("generation", "=", row.generation)
        .executeTakeFirst();
      await tx
        .updateTable("connections")
        .set({
          status: "disconnected",
          sealed: null,
          disconnected_at: now,
          disconnect_reason: reason,
          updated_at: now,
        })
        .where("id", "=", connectionId)
        .execute();
      await writeAudit(tx, {
        actor,
        action: "connection.disconnect",
        target: connectionId,
        detail: { definitionId: row.definition_id, reason },
      });
      return {
        sealed: row.sealed,
        definition: issuedUnder ? definitionFromRow(issuedUnder) : undefined,
      };
    });
    if (!ended) return false;
    const definition = ended.definition;
    const type = definition ? this.#definitions.types.get(definition.type) : undefined;
    if (definition && type?.revoke) {
      try {
        const credential = openCredential(this.#sealer, connectionId, ended.sealed);
        await type.revoke(
          leaseFor(definition, connectionId, credential),
          this.presetContext(definition, AbortSignal.timeout(ACCOUNT_LOOKUP_MS)),
        );
        await writeAudit(this.#db, {
          actor,
          action: "connection.revoke",
          target: connectionId,
          detail: { outcome: "revoked" },
        });
      } catch (error) {
        const code = error instanceof ServiceError ? error.code : "revoke-failed";
        this.#log.warn("provider revocation failed", {
          definitionId: definition.id,
          connectionId,
          error,
        });
        await writeAudit(this.#db, {
          actor,
          action: "connection.revoke",
          target: connectionId,
          detail: { outcome: "failed", code },
        });
      }
    }
    return true;
  }

  // ---- Operator listing ----

  async listConnections(
    filter: {
      definitionId?: string | undefined;
      status?: string | undefined;
      limit?: number | undefined;
    } = {},
  ): Promise<ConnectionRecord[]> {
    let query = this.#db
      .selectFrom("connections as c")
      .leftJoin("identities as i", "i.id", "c.owner_identity_id")
      .select([
        "c.id",
        "c.definition_id",
        "c.generation",
        "c.status",
        "c.account",
        "c.account_name",
        "c.scopes",
        "c.authorized_at",
        "c.credential_expires_at",
        "c.disconnected_at",
        "c.disconnect_reason",
        "i.deployment_id",
        "i.site_id",
        "i.user_id",
      ])
      .orderBy("c.updated_at", "desc")
      .limit(Math.min(Math.max(filter.limit ?? 500, 1), 5000));
    if (filter.definitionId) query = query.where("c.definition_id", "=", filter.definitionId);
    if (
      filter.status === "connected" ||
      filter.status === "needs-authorization" ||
      filter.status === "disconnected"
    )
      query = query.where("c.status", "=", filter.status);
    else if (filter.status === undefined) query = query.where("c.status", "<>", "disconnected");
    const rows = await query.execute();
    return rows.map((r) => ({
      id: r.id,
      definitionId: r.definition_id,
      generation: r.generation,
      owner:
        r.deployment_id && r.site_id && r.user_id
          ? identityKey({ deploymentId: r.deployment_id, siteId: r.site_id, userId: r.user_id })
          : null,
      status: r.status,
      account: r.account ? { id: r.account, name: r.account_name } : null,
      scopes: r.scopes,
      authorizedAt: r.authorized_at.toISOString(),
      credentialExpiresAt: r.credential_expires_at?.toISOString() ?? null,
      disconnectedAt: r.disconnected_at?.toISOString() ?? null,
      disconnectReason: r.disconnect_reason,
    }));
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID.test(value);
}

function connectInvalid(): ServiceError {
  return new ServiceError(
    400,
    "connect-transaction-invalid",
    "The connect link is not valid or has expired; start again",
  );
}

function identityMismatch(): ServiceError {
  return new ServiceError(
    403,
    "identity-mismatch",
    "This connect link was started by someone else",
  );
}

function definitionChanged(): ServiceError {
  return new ServiceError(
    409,
    "definition-changed",
    "The definition changed during setup; start again",
  );
}

function operatorRequired(): ServiceError {
  return new ServiceError(403, "operator-required", "This needs an operator sign-in");
}

function secretLinkInvalid(): ServiceError {
  return new ServiceError(
    410,
    "secret-link-invalid",
    "This secret link has been used or has expired",
  );
}
