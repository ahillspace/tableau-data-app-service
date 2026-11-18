import { sql } from "kysely";
import type { ConnectResult } from "../contracts/operator.ts";
import { isOperator } from "../identity/directory.ts";
import { actorOf, identityKey, type Principal, type SignInSession } from "../identity/types.ts";
import { writeAudit } from "../persistence/audit.ts";
import { type Db, transaction } from "../persistence/database.ts";
import type { Clock } from "../platform/clock.ts";
import { invalid, notFound, ServiceError } from "../platform/errors.ts";
import type { Log } from "../platform/log.ts";
import type { Outbound } from "../platform/outbound.ts";
import { hashToken, pkceChallenge, randomToken } from "../platform/secrets.ts";
import type { Sealer } from "../sealing/sealer.ts";
import { type DefinitionStore, definitionFromRow } from "./definitions.ts";
import type { Account, ExtensionContext } from "./extensions.ts";
import { selectApiHost } from "./hosts.ts";
import {
  configuredRequest,
  createJwt,
  normalizeCredential,
  readTokens,
  tokenRequest,
} from "./protocol.ts";
import { firstText } from "./selectors.ts";
import {
  connectionNeedsAuthorization,
  leaseFor,
  openCredential,
  readDefinitionSecret,
  replaceConnection,
  sealCredential,
} from "./store.ts";
import type {
  ConnectionDefinition,
  CredentialLease,
  DefinitionView,
  StoredCredential,
  Webhook,
} from "./types.ts";

const REFRESH_SKEW_MS = 60_000;
const TOKEN_TIMEOUT_MS = 30_000;
const CONNECT_TRANSACTION_MS = 10 * 60_000;
export type ConnectionStatus = "connected" | "needs-authorization" | "not-connected";
export type AppDefinition = {
  id: string;
  displayName: string;
  method: string;
  ownership: "shared" | "personal";
  setup: { oauth: boolean; credential: boolean };
  status: ConnectionStatus;
  account: Account | null;
  authorizedAt: string | null;
  scopes: string[];
};
export type ConnectionRecord = {
  id: string;
  definitionId: string;
  generation: number;
  credentialGeneration: number;
  credential: { set: boolean; setAt: string | null };
  owner: string | null;
  status: "connected" | "needs-authorization" | "disconnected";
  account: Account | null;
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
  metrics?: {
    recordCredentialFailure(definitionId: string, operation: "refresh" | "exchange"): void;
  };
};
export type CheckoutCaller = Pick<Principal, "identityId" | "trustedSiteId">;
function checkoutError(code: string): ServiceError {
  const messages: Record<string, string> = {
    "definition-not-found": "No such definition",
    "definition-disabled": "The definition is disabled",
    "not-in-audience": "Your Tableau site cannot use this definition",
    "not-connected": "There is no connection for this definition",
    "needs-authorization": "The connection needs authorization again",
  };
  return new ServiceError(
    code === "definition-not-found" ? 404 : 403,
    code,
    messages[code] ?? "Checkout failed",
    { upstream: "not-sent" },
  );
}
function changed(): ServiceError {
  return new ServiceError(
    409,
    "definition-changed",
    "The definition or setup changed; start again",
  );
}
function connectInvalid(): ServiceError {
  return new ServiceError(
    400,
    "connect-transaction-invalid",
    "This connect transaction expired or has already been used",
  );
}
function mismatch(): ServiceError {
  return new ServiceError(
    403,
    "identity-mismatch",
    "Sign in with the identity that started this connection",
  );
}
function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Connection custody and one finite protocol engine, independent of catalog/provider names. */
export class ConnectionService {
  readonly #db: Db;
  readonly #definitions: DefinitionStore;
  readonly #sealer: Sealer;
  readonly #outbound: Outbound;
  readonly #origin: string;
  readonly #clock: Clock;
  readonly #log: Log;
  readonly #metrics: ConnectionsOptions["metrics"];
  constructor(options: ConnectionsOptions) {
    this.#db = options.db;
    this.#definitions = options.definitions;
    this.#sealer = options.sealer;
    this.#outbound = options.outbound;
    this.#origin = options.publicOrigin;
    this.#clock = options.clock;
    this.#log = options.log;
    this.#metrics = options.metrics;
  }
  get callbackUri(): string {
    return `${this.#origin}/v1/oauth/callback`;
  }
  get definitions(): DefinitionStore {
    return this.#definitions;
  }
  extensionContext(definition: ConnectionDefinition, signal: AbortSignal): ExtensionContext {
    return { fetch: this.#outbound.fetcher(definition.privateHosts), signal };
  }
  async #live(id: string): Promise<ConnectionDefinition> {
    const row = await this.#db
      .selectFrom("definitions")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) throw checkoutError("definition-not-found");
    if (!row.enabled || row.retired) throw checkoutError("definition-disabled");
    return definitionFromRow(row);
  }
  /** Definition authority is locked before the connection, including on rotation/disconnect. */
  async checkout(
    principal: CheckoutCaller,
    id: string,
    signal = new AbortController().signal,
    requestedHost?: string,
  ): Promise<CredentialLease> {
    const result = await transaction(this.#db, async (tx) => {
      await sql`select set_config('lock_timeout', '45000ms', true), set_config('idle_in_transaction_session_timeout', '45000ms', true)`.execute(
        tx,
      );
      const stored = await tx
        .selectFrom("definitions")
        .selectAll()
        .where("id", "=", id)
        .forShare()
        .executeTakeFirst();
      if (!stored) throw checkoutError("definition-not-found");
      const d = definitionFromRow(stored),
        auth = d.authentication;
      if (!d.enabled || d.retired) throw checkoutError("definition-disabled");
      if (!d.audience.includes(principal.trustedSiteId)) throw checkoutError("not-in-audience");
      if (auth.method === "none") return { lease: leaseFor(d, null, null) };
      let query = tx
        .selectFrom("connections")
        .selectAll()
        .where("definition_id", "=", id)
        .where("generation", "=", d.generation)
        .where("status", "<>", "disconnected");
      query =
        d.ownership === "shared"
          ? query.where("owner_identity_id", "is", null)
          : query.where("owner_identity_id", "=", principal.identityId);
      const row = await query.forUpdate().executeTakeFirst();
      if (!row?.sealed) throw checkoutError("not-connected");
      const now = this.#clock.now();
      if (row.status === "needs-authorization") throw checkoutError("needs-authorization");
      if (connectionNeedsAuthorization(d, row, now)) {
        await tx
          .updateTable("connections")
          .set({
            status: "needs-authorization",
            disconnect_reason: "reauthorization-interval",
            updated_at: now,
          })
          .where("id", "=", row.id)
          .execute();
        return { rejected: true };
      }
      let credential = openCredential(this.#sealer, row.id, row.sealed);
      let scopes = row.scopes;
      if (auth.method === "static") return { lease: leaseFor(d, row.id, credential) };
      const generated = auth.method !== "authorization_code";
      const selectedOrigin =
        auth.method === "signed_jwt_direct" && typeof auth.jwt.audience !== "string"
          ? new URL(selectApiHost(d.apiHosts, requestedHost)).origin
          : undefined;
      const cacheKey = JSON.stringify([
        d.generation,
        d.secretGeneration,
        row.credential_generation,
        [...new Set(d.scopes)].sort(),
        auth.method === "signed_jwt_direct"
          ? typeof auth.jwt.audience === "string"
            ? auth.jwt.audience
            : selectedOrigin
          : auth.method === "jwt_bearer"
            ? auth.jwt.audience
            : "",
      ]);
      const valid = credential.expiresAt
        ? Date.parse(credential.expiresAt) -
            Math.min(
              REFRESH_SKEW_MS,
              "jwt" in auth ? (auth.jwt.ttlSeconds * 1000) / 10 : REFRESH_SKEW_MS,
            ) >
          now.getTime()
        : !!credential.accessToken;
      if ((!generated || credential.derivedKey === cacheKey) && valid)
        return { lease: leaseFor(d, row.id, credential) };
      const refresh = auth.method === "authorization_code";
      if (refresh && !credential.refreshToken) {
        if (
          credential.accessToken &&
          (!credential.expiresAt || Date.parse(credential.expiresAt) > now.getTime())
        )
          return { lease: leaseFor(d, row.id, credential) };
        await tx
          .updateTable("connections")
          .set({ status: "needs-authorization", disconnect_reason: "expired", updated_at: now })
          .where("id", "=", row.id)
          .execute();
        return { rejected: true };
      }
      const operation = refresh ? "refresh" : "exchange";
      try {
        if (auth.method === "signed_jwt_direct") {
          if (credential.input?.kind !== "jwt") throw checkoutError("not-connected");
          credential = {
            ...credential,
            accessToken: createJwt(
              auth.jwt,
              credential.input.privateKey,
              credential.input,
              d.scopes,
              selectedOrigin,
              now,
            ),
            expiresAt: new Date(
              Math.floor(now.getTime() / 1000) * 1000 + auth.jwt.ttlSeconds * 1000,
            ).toISOString(),
            derivedKey: cacheKey,
          };
        } else {
          let parameters: Record<string, string>;
          if (refresh)
            parameters = {
              grant_type: "refresh_token",
              refresh_token: credential.refreshToken as string,
            };
          else if (auth.method === "client_credentials")
            parameters = {
              grant_type: "client_credentials",
              ...(d.scopes.length
                ? { [auth.scopeParameter.name]: d.scopes.join(auth.scopeParameter.separator) }
                : {}),
            };
          else if (auth.method === "jwt_bearer") {
            if (credential.input?.kind !== "jwt") throw checkoutError("not-connected");
            parameters = {
              grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
              assertion: createJwt(
                auth.jwt,
                credential.input.privateKey,
                credential.input,
                d.scopes,
                undefined,
                now,
              ),
            };
          } else throw checkoutError("not-connected");
          const secrets = {
            clientSecret: await readDefinitionSecret(tx, this.#sealer, id, "clientSecret"),
            signingPrivateKey: await readDefinitionSecret(
              tx,
              this.#sealer,
              id,
              "signingPrivateKey",
            ),
          };
          let response: { status: number; body: unknown };
          try {
            response = await tokenRequest(
              this.#outbound,
              d,
              secrets,
              parameters,
              refresh,
              now,
              AbortSignal.any([signal, AbortSignal.timeout(TOKEN_TIMEOUT_MS)]),
            );
          } catch (error) {
            if (error instanceof ServiceError && error.upstream === "not-sent") throw error;
            throw new ServiceError(
              502,
              `${operation}-uncertain`,
              "The credential operation may have reached the provider",
              { upstream: "not-sent" },
            );
          }
          const config =
            refresh && auth.method === "authorization_code"
              ? (auth.refreshResponse ?? auth.response)
              : auth.response;
          const reading = readTokens(config, response, this.#clock.now());
          if (reading.kind === "error") {
            if (reading.rejectsGrant && refresh) {
              await tx
                .updateTable("connections")
                .set({
                  status: "needs-authorization",
                  disconnect_reason: "refresh-rejected",
                  updated_at: this.#clock.now(),
                })
                .where("id", "=", row.id)
                .execute();
              this.#failure(id, operation);
              return { rejected: true };
            }
            throw new ServiceError(
              502,
              `${operation}-${reading.definitive ? "failed" : "uncertain"}`,
              reading.definitive
                ? "The provider refused the credential operation"
                : "The credential operation outcome is unknown",
              { upstream: "not-sent" },
            );
          }
          credential = {
            ...reading.credential,
            ...(credential.input === undefined ? {} : { input: credential.input }),
            ...(reading.credential.refreshToken === undefined &&
            credential.refreshToken !== undefined
              ? { refreshToken: credential.refreshToken }
              : {}),
            ...(generated ? { derivedKey: cacheKey } : {}),
          };
          scopes = reading.scopes ?? scopes;
        }
        await tx
          .updateTable("connections")
          .set({
            sealed: JSON.stringify(sealCredential(this.#sealer, row.id, credential)),
            scopes: JSON.stringify(scopes),
            credential_expires_at: credential.expiresAt ? new Date(credential.expiresAt) : null,
            updated_at: this.#clock.now(),
          })
          .where("id", "=", row.id)
          .execute();
        return { lease: leaseFor(d, row.id, credential) };
      } catch (error) {
        this.#failure(id, operation);
        throw error;
      }
    });
    if (!result.lease) throw checkoutError("needs-authorization");
    return result.lease;
  }
  #failure(id: string, operation: "refresh" | "exchange"): void {
    try {
      this.#metrics?.recordCredentialFailure(id, operation);
    } catch {}
  }
  async listForApp(principal: Principal): Promise<AppDefinition[]> {
    const definitions = [...(await this.#definitions.current({ force: true })).values()].filter(
      (d) => d.enabled && !d.retired && d.audience.includes(principal.trustedSiteId),
    );
    const rows = await this.#db
      .selectFrom("connections")
      .selectAll()
      .where("status", "<>", "disconnected")
      .where((eb) =>
        eb.or([
          eb("owner_identity_id", "is", null),
          eb("owner_identity_id", "=", principal.identityId),
        ]),
      )
      .execute();
    return definitions
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((d) => {
        const row = rows.find(
          (c) =>
            c.definition_id === d.id &&
            c.generation === d.generation &&
            (d.ownership === "shared"
              ? c.owner_identity_id === null
              : c.owner_identity_id === principal.identityId),
        );
        const lapsed = row && connectionNeedsAuthorization(d, row, this.#clock.now());
        return {
          id: d.id,
          displayName: d.displayName,
          method: d.authentication.method,
          ownership: d.ownership,
          setup: {
            oauth: d.ownership === "personal" && d.authentication.method === "authorization_code",
            credential:
              d.ownership === "personal" &&
              ["static", "jwt_bearer", "signed_jwt_direct"].includes(d.authentication.method),
          },
          status:
            d.authentication.method === "none"
              ? "connected"
              : row
                ? row.status === "connected" && !lapsed
                  ? "connected"
                  : "needs-authorization"
                : "not-connected",
          account: row?.account ? { id: row.account, name: row.account_name } : null,
          authorizedAt: row?.authorized_at.toISOString() ?? null,
          scopes: row?.scopes ?? [],
        };
      });
  }
  startConnect(
    principal: Principal,
    id: string,
    mode: "personal",
  ): Promise<Extract<ConnectResult, { kind: "redirect" }>>;
  startConnect(
    principal: Principal,
    id: string,
    mode: "personal" | "shared",
  ): Promise<ConnectResult>;
  async startConnect(
    principal: Principal,
    id: string,
    mode: "personal" | "shared",
  ): Promise<ConnectResult> {
    const d = await this.#live(id);
    if (d.ownership !== mode)
      throw new ServiceError(
        409,
        mode === "shared" ? "personal-definition" : "shared-definition",
        "The definition uses a different connection ownership mode",
      );
    if (mode === "personal" && !d.audience.includes(principal.trustedSiteId))
      throw checkoutError("not-in-audience");
    if (mode === "shared" && d.authentication.method === "client_credentials")
      return this.#definitions.connectMachine(principal, id);
    if (d.authentication.method !== "authorization_code")
      throw new ServiceError(
        409,
        "connect-not-supported",
        "Only authorization code connections use browser setup",
      );
    const expiresAt = new Date(this.#clock.now().getTime() + CONNECT_TRANSACTION_MS);
    const row = await this.#db
      .insertInto("connect_transactions")
      .values({
        definition_id: id,
        generation: d.generation,
        identity_id: principal.identityId,
        shared: mode === "shared",
        expires_at: expiresAt,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return {
      kind: "redirect",
      transactionId: row.id,
      url: `${this.#origin}/connect/${row.id}`,
      expiresAt: expiresAt.toISOString(),
    };
  }
  async beginConnect(id: string, session: SignInSession): Promise<URL> {
    if (!uuid(id)) throw connectInvalid();
    const tx = await this.#db
      .selectFrom("connect_transactions")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!tx || tx.status !== "pending" || tx.expires_at <= this.#clock.now())
      throw connectInvalid();
    if (tx.identity_id !== session.identityId) throw mismatch();
    if (tx.shared && !(await isOperator(this.#db, session.identity)))
      throw new ServiceError(
        403,
        "operator-required",
        "Connecting a shared definition needs an operator",
      );
    const d = await this.#live(tx.definition_id),
      auth = d.authentication;
    if (d.generation !== tx.generation || auth.method !== "authorization_code") throw changed();
    const state = randomToken(),
      verifier = randomToken();
    await this.#db
      .updateTable("connect_transactions")
      .set({ state_hash: hashToken(state), pkce_verifier: verifier, started: true })
      .where("id", "=", id)
      .where("status", "=", "pending")
      .execute();
    const url = new URL(auth.authorizationEndpoint);
    for (const [key, value] of Object.entries(auth.authorizeParameters ?? {}))
      url.searchParams.set(key, value);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: auth.clientAuthentication.clientId as string,
      redirect_uri: this.callbackUri,
      state,
      ...(auth.pkce === "S256"
        ? { code_challenge: pkceChallenge(verifier), code_challenge_method: "S256" }
        : {}),
      ...(d.scopes.length
        ? { [auth.scopeParameter.name]: d.scopes.join(auth.scopeParameter.separator) }
        : {}),
    }))
      url.searchParams.set(key, value);
    return url;
  }
  async completeConnect(input: {
    query: URLSearchParams;
    session: SignInSession | undefined;
    signal?: AbortSignal;
  }): Promise<{ transactionId: string; definitionId: string }> {
    const state = input.query.get("state");
    if (!state) throw connectInvalid();
    const tx = await this.#db
      .updateTable("connect_transactions")
      .set({ state_hash: null })
      .where("state_hash", "=", hashToken(state))
      .returningAll()
      .executeTakeFirst();
    if (tx?.status === "failed" && tx.failure === "definition-changed") throw changed();
    if (!tx || tx.status !== "pending" || tx.expires_at <= this.#clock.now() || !tx.pkce_verifier)
      throw connectInvalid();
    try {
      if (!input.session || input.session.identityId !== tx.identity_id) throw mismatch();
      if (input.query.has("error"))
        throw new ServiceError(
          400,
          "authorization-denied",
          "The provider did not authorize the connection",
        );
      const code = input.query.get("code");
      if (!code)
        throw new ServiceError(
          400,
          "authorization-invalid",
          "The provider returned no authorization code",
        );
      const {
        definition: d,
        authentication: auth,
        secrets,
      } = await transaction(this.#db, async (t) => {
        const row = await t
          .selectFrom("definitions")
          .selectAll()
          .where("id", "=", tx.definition_id)
          .forShare()
          .executeTakeFirst();
        if (!row) throw checkoutError("definition-not-found");
        if (!row.enabled || row.retired) throw checkoutError("definition-disabled");
        const definition = definitionFromRow(row),
          authentication = definition.authentication;
        if (
          definition.generation !== tx.generation ||
          authentication.method !== "authorization_code"
        )
          throw changed();
        return {
          definition,
          authentication,
          secrets: {
            clientSecret: await readDefinitionSecret(
              t,
              this.#sealer,
              definition.id,
              "clientSecret",
            ),
            signingPrivateKey: await readDefinitionSecret(
              t,
              this.#sealer,
              definition.id,
              "signingPrivateKey",
            ),
          },
        };
      });
      const response = await tokenRequest(
        this.#outbound,
        d,
        secrets,
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: this.callbackUri,
          ...(auth.pkce === "S256" ? { code_verifier: tx.pkce_verifier } : {}),
        },
        false,
        this.#clock.now(),
        input.signal ?? AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      );
      const reading = readTokens(auth.response, response, this.#clock.now());
      if (reading.kind === "error")
        throw new ServiceError(
          502,
          reading.definitive ? "exchange-failed" : "exchange-uncertain",
          reading.definitive
            ? "The provider refused the token request"
            : "The token request outcome is unknown",
        );
      const connectionId = await transaction(this.#db, async (t) => {
        const row = await t
          .selectFrom("definitions")
          .selectAll()
          .where("id", "=", d.id)
          .forShare()
          .executeTakeFirst();
        if (
          !row ||
          row.retired ||
          !row.enabled ||
          row.generation !== d.generation ||
          row.secret_generation !== d.secretGeneration
        )
          throw changed();
        if (
          tx.shared &&
          !(await isOperator(t, (input.session as SignInSession).identity, { hold: true }))
        )
          throw new ServiceError(403, "operator-required", "Operator access was removed");
        const id = await replaceConnection(t, this.#sealer, {
          definition: d,
          ownerIdentityId: tx.shared ? null : tx.identity_id,
          credential: reading.credential,
          account: reading.account,
          scopes: reading.scopes ?? d.scopes,
          now: this.#clock.now(),
        });
        await t
          .updateTable("connect_transactions")
          .set({ status: "connected", pkce_verifier: null })
          .where("id", "=", tx.id)
          .execute();
        if (tx.shared)
          await writeAudit(t, {
            actor: `operator:${identityKey((input.session as SignInSession).identity)}`,
            action: "connection.connect",
            target: d.id,
          });
        return id;
      });
      if (!reading.account) await this.#lookup(d, connectionId);
      return { transactionId: tx.id, definitionId: d.id };
    } catch (error) {
      this.#failure(tx.definition_id, "exchange");
      await this.#db
        .updateTable("connect_transactions")
        .set({
          status: "failed",
          failure: error instanceof ServiceError ? error.code : "exchange-failed",
          pkce_verifier: null,
        })
        .where("id", "=", tx.id)
        .execute();
      throw error;
    }
  }
  async setPersonalCredential(
    principal: Principal,
    id: string,
    raw: unknown,
  ): Promise<AppDefinition | undefined> {
    const d = await this.#live(id);
    if (d.ownership !== "personal")
      throw new ServiceError(409, "shared-definition", "An operator sets shared credentials");
    if (!d.audience.includes(principal.trustedSiteId)) throw checkoutError("not-in-audience");
    const credential: StoredCredential = { input: normalizeCredential(d, raw) };
    const connection = await transaction(this.#db, async (tx) => {
      const live = await tx
        .selectFrom("definitions")
        .selectAll()
        .where("id", "=", id)
        .forShare()
        .executeTakeFirst();
      if (!live || !live.enabled || live.retired || live.generation !== d.generation)
        throw changed();
      return replaceConnection(tx, this.#sealer, {
        definition: d,
        ownerIdentityId: principal.identityId,
        credential,
        account: null,
        scopes: d.scopes,
        now: this.#clock.now(),
      });
    });
    await this.#lookup(d, connection);
    return (await this.listForApp(principal)).find((d) => d.id === id);
  }
  /** Enrichment is optional after custody commits; it never changes the mutation's outcome. */
  async afterDefinitionMutation(view: DefinitionView): Promise<DefinitionView> {
    if (
      !view.accountLookup ||
      view.ownership !== "shared" ||
      view.authentication.method !== "static" ||
      view.setup.state !== "ready" ||
      !view.credential.set
    )
      return view;
    await this.#lookup(view);
    return view;
  }
  #lookupFailed(definitionId: string): void {
    try {
      this.#log.info("account lookup failed", { definitionId, errorCode: "account-lookup-failed" });
    } catch {}
  }
  async #lookup(
    expected: {
      id: string;
      generation: number;
      secretGeneration?: number;
      version: number;
    },
    connectionId?: string,
  ): Promise<void> {
    try {
      const snapshot = await transaction(this.#db, async (tx) => {
        const stored = await tx
          .selectFrom("definitions")
          .selectAll()
          .where("id", "=", expected.id)
          .forShare()
          .executeTakeFirst();
        if (
          !stored ||
          !stored.enabled ||
          stored.retired ||
          stored.generation !== expected.generation ||
          (expected.secretGeneration !== undefined &&
            stored.secret_generation !== expected.secretGeneration) ||
          stored.version !== expected.version
        )
          return undefined;
        const definition = definitionFromRow(stored);
        if (!definition.accountLookup) return undefined;
        let query = tx
          .selectFrom("connections")
          .selectAll()
          .where("definition_id", "=", definition.id)
          .where("generation", "=", definition.generation)
          .where("status", "=", "connected");
        query = connectionId
          ? query.where("id", "=", connectionId)
          : query.where("owner_identity_id", "is", null);
        const row = await query.forShare().executeTakeFirst();
        if (!row?.sealed || connectionNeedsAuthorization(definition, row, this.#clock.now()))
          return undefined;
        return {
          definition,
          accountLookup: definition.accountLookup,
          id: row.id,
          credentialGeneration: row.credential_generation,
          credential: openCredential(this.#sealer, row.id, row.sealed),
        };
      });
      if (!snapshot) return;
      const { definition: d, accountLookup, id, credential, credentialGeneration } = snapshot;
      const body = await configuredRequest(
        this.#outbound,
        d,
        accountLookup,
        credential,
        AbortSignal.timeout(5000),
      );
      const account = firstText(body, accountLookup.id);
      if (!account) return;
      await transaction(this.#db, async (tx) => {
        const live = await tx
          .selectFrom("definitions")
          .selectAll()
          .where("id", "=", d.id)
          .forShare()
          .executeTakeFirst();
        if (
          !live ||
          !live.enabled ||
          live.retired ||
          live.generation !== d.generation ||
          live.secret_generation !== d.secretGeneration
        )
          return;
        await tx
          .updateTable("connections")
          .set({ account, account_name: firstText(body, accountLookup.name) ?? null })
          .where("id", "=", id)
          .where("generation", "=", d.generation)
          .where("credential_generation", "=", credentialGeneration)
          .where("status", "=", "connected")
          .execute();
      });
    } catch {
      this.#lookupFailed(expected.id);
    }
  }
  async webhookSnapshot(
    id: string,
  ): Promise<{ webhook: Webhook; signingSecret: string | undefined }> {
    return transaction(this.#db, async (tx) => {
      const row = await tx
        .selectFrom("definitions")
        .selectAll()
        .where("id", "=", id)
        .forShare()
        .executeTakeFirst();
      if (!row) throw notFound("definition-not-found", "No such definition");
      if (!row.enabled || row.retired)
        throw new ServiceError(403, "definition-disabled", "The definition is disabled");
      const definition = definitionFromRow(row);
      if (!definition.webhook)
        throw new ServiceError(
          409,
          "events-not-supported",
          "The definition has no webhook configuration",
        );
      return {
        webhook: definition.webhook,
        signingSecret: await readDefinitionSecret(tx, this.#sealer, id, "signingSecret"),
      };
    });
  }
  async disconnectOwn(principal: Principal, id: string): Promise<boolean> {
    const d = await this.#live(id);
    if (d.ownership !== "personal")
      throw new ServiceError(409, "shared-definition", "Operators disconnect shared connections");
    const row = await this.#db
      .selectFrom("connections")
      .select("id")
      .where("definition_id", "=", id)
      .where("owner_identity_id", "=", principal.identityId)
      .where("status", "<>", "disconnected")
      .executeTakeFirst();
    return row ? this.#disconnect(row.id, "owner", actorOf(principal)) : false;
  }
  async disconnectAny(principal: Principal, id: string): Promise<boolean> {
    if (!uuid(id)) throw notFound("connection-not-found", "No such connection");
    return this.#disconnect(id, "operator", actorOf(principal));
  }
  async #disconnect(id: string, reason: string, actor: string): Promise<boolean> {
    const preliminary = await this.#db
      .selectFrom("connections")
      .select("definition_id")
      .where("id", "=", id)
      .executeTakeFirst();
    if (!preliminary) throw notFound("connection-not-found", "No such connection");
    const ended = await transaction(this.#db, async (tx) => {
      const definition = await tx
        .selectFrom("definitions")
        .selectAll()
        .where("id", "=", preliminary.definition_id)
        .forShare()
        .executeTakeFirstOrThrow();
      const row = await tx
        .selectFrom("connections")
        .selectAll()
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (!row?.sealed || row.status === "disconnected") return undefined;
      const d = definitionFromRow(definition),
        credential = openCredential(this.#sealer, id, row.sealed);
      await tx
        .updateTable("connections")
        .set({
          status: "disconnected",
          sealed: null,
          disconnected_at: this.#clock.now(),
          disconnect_reason: reason,
          updated_at: this.#clock.now(),
        })
        .where("id", "=", id)
        .execute();
      await writeAudit(tx, { actor, action: "connection.disconnect", target: d.id });
      return { definition: d, credential };
    });
    if (!ended) return false;
    if (ended.definition.revocation) {
      try {
        await configuredRequest(
          this.#outbound,
          ended.definition,
          ended.definition.revocation,
          ended.credential,
          AbortSignal.timeout(5000),
        );
      } catch {
        await writeAudit(this.#db, {
          actor,
          action: "connection.revoke-failed",
          target: ended.definition.id,
          detail: { code: "revoke-failed" },
        });
      }
    }
    return true;
  }
  async listConnections(
    filter: {
      definitionId?: string | undefined;
      status?: string | undefined;
      limit?: number | undefined;
    } = {},
  ): Promise<ConnectionRecord[]> {
    if (
      filter.status !== undefined &&
      !["connected", "needs-authorization", "disconnected"].includes(filter.status)
    )
      throw invalid([{ path: "status", rule: "connection-status" }]);
    let query = this.#db
      .selectFrom("connections")
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(Math.min(filter.limit ?? 100, 1000));
    if (filter.definitionId) query = query.where("definition_id", "=", filter.definitionId);
    if (filter.status)
      query = query.where("status", "=", filter.status as ConnectionRecord["status"]);
    return (await query.execute()).map((r) => ({
      id: r.id,
      definitionId: r.definition_id,
      generation: r.generation,
      credentialGeneration: r.credential_generation,
      credential: {
        set: r.sealed !== null,
        setAt: r.sealed ? r.credential_set_at.toISOString() : null,
      },
      owner: r.owner_identity_id,
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
