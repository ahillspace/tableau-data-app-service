import { randomUUID } from "node:crypto";
import * as oauth from "oauth4webapi";
import { z } from "zod";
import type { AccessService } from "../access/service.js";
import { authFailure } from "../access/service.js";
import type { AccessContext } from "../core-ports.js";
import { type Database, databaseTime } from "../db/database.js";
import { absent, ServiceError, stale } from "../http/errors.js";
import { providerProtocol } from "../providers/protocol.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { AuthorizationBegin, AuthorizationView } from "../public/schemas.js";
import type { SecretBox } from "../security/encryption.js";
import { randomSecret, verifier, verifySecret } from "../security/secrets.js";
import { protocolJson } from "../transport/json.js";
import type { TransportPolicy } from "../transport/native.js";
import type { CredentialAuthority, CredentialsService, MutationRef } from "./credentials.js";
import type { OperatorConnections, SharedAudience } from "./operator.js";

const protocolStateSchema = z.strictObject({ state: z.string(), codeVerifier: z.string() });
export class AuthorizationService {
  readonly incarnation = randomUUID();
  constructor(
    readonly db: Database,
    readonly access: AccessService,
    readonly credentials: CredentialsService,
    readonly providers: ProviderRegistry,
    readonly secrets: SecretBox,
    readonly policy: TransportPolicy,
    readonly lifetimeMs: number,
    readonly leaseMs: number,
    readonly operators?: OperatorConnections,
  ) {}
  private async load(id: string) {
    const attempt = await this.db
      .selectFrom("authorizations")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!attempt) absent();
    const mutation = await this.db
      .selectFrom("credential_mutations")
      .selectAll()
      .where("id", "=", attempt.mutation_id)
      .executeTakeFirstOrThrow();
    const ref: MutationRef = {
      id: mutation.id,
      kind: mutation.kind,
      connectionId: mutation.connection_id,
      setupId: mutation.setup_id,
      expected: {
        authorityGeneration: mutation.expected_authority,
        credentialGeneration: mutation.expected_credential,
      },
      expiresAt: mutation.expires_at,
    };
    if (attempt.operator_context) {
      if (!this.operators)
        throw new ServiceError(
          403,
          "operator-authority-unavailable",
          "Operator authority is unavailable",
        );
      return {
        attempt,
        ref,
        access: this.operators.actor(
          attempt.operator_context.actorId,
          attempt.app_id,
          attempt.provider_registration_id,
          attempt.operator_context.audience,
          attempt.expires_at,
        ),
      };
    }
    const session = await this.db
      .selectFrom("sessions as s")
      .innerJoin("owners as o", "o.id", "s.owner_id")
      .select([
        "s.id as sessionId",
        "s.authentication_expires_at as authenticationExpiresAt",
        "o.id as ownerId",
        "o.deployment_id as deploymentId",
        "o.site_id as siteId",
        "o.subject_id as subjectId",
      ])
      .where("s.id", "=", attempt.session_id ?? "")
      .executeTakeFirstOrThrow();
    return { attempt, ref, access: { ...session, appId: attempt.app_id } };
  }
  async begin(access: AccessContext, input: AuthorizationBegin): Promise<AuthorizationView> {
    return this.beginAs(access, access.appId, input, null);
  }
  async beginOperator(
    actorId: string,
    appId: string,
    input: AuthorizationBegin,
    audience: SharedAudience,
  ): Promise<AuthorizationView> {
    if (!this.operators)
      throw new ServiceError(
        403,
        "operator-authority-unavailable",
        "Operator authority is unavailable",
      );
    return this.beginAs(
      this.operators.actor(actorId, appId, input.providerRegistrationId, audience),
      appId,
      input,
      { actorId, audience: [...audience] },
    );
  }
  private async beginAs(
    access: CredentialAuthority,
    appId: string,
    input: AuthorizationBegin,
    operatorContext: {
      actorId: string;
      audience: { deploymentId: string; siteId: string; subjectId: string }[];
    } | null,
  ): Promise<AuthorizationView> {
    const provider = this.providers.get(input.providerRegistrationId);
    if (
      provider.mode !== (operatorContext ? "operator" : "personal") ||
      !provider.oauth ||
      input.permissionOption ||
      (input.inputs && Object.keys(input.inputs).length)
    )
      throw new ServiceError(
        422,
        "unsupported-setup",
        "Provider authorization option is unsupported",
      );
    const id = randomUUID(),
      expiresAt = new Date(
        Math.min(access.authenticationExpiresAt.getTime(), Date.now() + this.lifetimeMs),
      );
    await this.credentials.reserve(
      access,
      provider.id,
      "setup",
      expiresAt,
      input.replacement,
      id,
      async (tx, ref) => {
        await tx
          .insertInto("authorizations")
          .values({
            id,
            provider_registration_id: provider.id,
            app_id: appId,
            session_id: access.sessionId,
            owner_id: access.ownerId,
            operator_context: operatorContext,
            mutation_id: ref.id,
            initiation_verifier: input.initiationVerifier,
            browser_verifier: null,
            state_verifier: null,
            protected_state: null,
            state: "pending",
            launched: false,
            expires_at: expiresAt,
            connection_id: null,
          })
          .execute();
      },
    );
    return { id, state: "pending", expiresAt: expiresAt.toISOString() };
  }
  async view(access: AccessContext, id: string): Promise<AuthorizationView> {
    const { attempt } = await this.load(id);
    if (attempt.owner_id !== access.ownerId || attempt.session_id !== access.sessionId) absent();
    const time = await this.db.transaction().execute(async (tx) => {
      await this.access.lockAuthority(tx, access, attempt.provider_registration_id);
      return databaseTime(tx);
    });
    return {
      id,
      state:
        attempt.expires_at <= time && ["pending", "exchanging"].includes(attempt.state)
          ? "expired"
          : attempt.state,
      expiresAt: attempt.expires_at.toISOString(),
      ...(attempt.connection_id ? { connectionId: attempt.connection_id } : {}),
    };
  }
  async viewOperator(actorId: string, appId: string, id: string): Promise<AuthorizationView> {
    const current = await this.load(id);
    if (
      current.attempt.operator_context?.actorId !== actorId ||
      current.attempt.app_id !== appId ||
      !("lock" in current.access)
    )
      absent();
    const actor = this.operators!.actor(
      actorId,
      appId,
      current.attempt.provider_registration_id,
      current.attempt.operator_context.audience,
    );
    const time = await this.db.transaction().execute(async (tx) => {
      await actor.lock(tx, current.attempt.provider_registration_id, current.ref);
      return databaseTime(tx);
    });
    return {
      id,
      state:
        current.attempt.expires_at <= time &&
        ["pending", "exchanging"].includes(current.attempt.state)
          ? "expired"
          : current.attempt.state,
      expiresAt: current.attempt.expires_at.toISOString(),
      ...(current.attempt.connection_id ? { connectionId: current.attempt.connection_id } : {}),
    };
  }
  async cancelOperator(actorId: string, appId: string, id: string): Promise<AuthorizationView> {
    await this.viewOperator(actorId, appId, id);
    const current = await this.load(id);
    await this.credentials.recover(current.ref, true, {
      initiator: { access: current.access, providerId: current.attempt.provider_registration_id },
      finalize: async (tx) => {
        await tx
          .updateTable("authorizations")
          .set({ state: "cancelled", protected_state: null, browser_verifier: null })
          .where("id", "=", id)
          .where("state", "in", ["pending", "exchanging"])
          .execute();
      },
    });
    return this.viewOperator(actorId, appId, id);
  }
  async launch(
    id: string,
    proof: string,
  ): Promise<{ authorizationUrl: string; browserSecret: string }> {
    const { attempt, ref, access } = await this.load(id);
    if (!verifySecret(proof, attempt.initiation_verifier)) throw authFailure();
    const provider = this.providers.get(attempt.provider_registration_id),
      definition = provider.oauth;
    if (!definition) throw new ServiceError(422, "unsupported-setup", "OAuth is unsupported");
    const state = randomSecret(),
      codeVerifier = oauth.generateRandomCodeVerifier(),
      browserSecret = randomSecret();
    const encrypted = this.secrets.seal(Buffer.from(JSON.stringify({ state, codeVerifier })), {
      kind: "authorization",
      id,
      provider: provider.id,
      revision: "1",
    });
    const url = new URL(definition.metadata.authorization_endpoint ?? "");
    for (const [name, value] of Object.entries(definition.authorizationParameters ?? {})) {
      if (
        [
          "state",
          "client_id",
          "redirect_uri",
          "response_type",
          "code_challenge",
          "code_challenge_method",
        ].includes(name)
      )
        throw new Error("Provider attempted to override a protected OAuth parameter");
      url.searchParams.set(name, value);
    }
    for (const [name, value] of Object.entries({
      response_type: "code",
      client_id: definition.clientId,
      redirect_uri: definition.callbackUri,
      state,
      ...(definition.pkce
        ? {
            code_challenge: await oauth.calculatePKCECodeChallenge(codeVerifier),
            code_challenge_method: "S256",
          }
        : {}),
      ...(definition.scope ? { scope: definition.scope } : {}),
    }))
      url.searchParams.set(name, value);
    const claim = await this.credentials.claim(
      access,
      provider.id,
      ref,
      this.incarnation,
      this.leaseMs,
      async (tx) => {
        const current = await tx
          .selectFrom("authorizations")
          .selectAll()
          .where("id", "=", id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (
          current.state !== "pending" ||
          current.launched ||
          current.expires_at <= (await databaseTime(tx))
        )
          stale();
        await tx
          .updateTable("authorizations")
          .set({
            launched: true,
            state_verifier: verifier(state),
            browser_verifier: verifier(browserSecret),
            protected_state: encrypted,
          })
          .where("id", "=", id)
          .execute();
      },
    );
    try {
      await this.credentials.dispatch(
        access,
        provider.id,
        ref,
        claim,
        definition.launchMayInvalidate,
      );
      await this.credentials.wait(access, provider.id, ref, claim);
      return { authorizationUrl: url.href, browserSecret };
    } catch (error) {
      await this.credentials.recover(ref, true);
      throw error;
    }
  }
  async callback(
    registrationId: string,
    parameters: URLSearchParams,
    browserSecret: string | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    if (parameters.getAll("state").length !== 1 || !browserSecret) throw authFailure();
    const hint = await this.db
      .selectFrom("authorizations")
      .select("id")
      .where("state_verifier", "=", verifier(parameters.get("state") ?? ""))
      .where("provider_registration_id", "=", registrationId)
      .executeTakeFirst();
    if (!hint) throw authFailure();
    const { attempt, ref, access } = await this.load(hint.id);
    const provider = this.providers.get(registrationId),
      definition = provider.oauth;
    if (!definition || !attempt.protected_state) throw authFailure();
    const bytes = this.secrets.open(attempt.protected_state, {
      kind: "authorization",
      id: attempt.id,
      provider: registrationId,
      revision: "1",
    });
    let state: z.infer<typeof protocolStateSchema>;
    try {
      state = protocolStateSchema.parse(JSON.parse(bytes.toString()));
    } finally {
      bytes.fill(0);
    }
    const client: oauth.Client = { client_id: definition.clientId };
    if (!attempt.browser_verifier || !verifySecret(browserSecret, attempt.browser_verifier))
      throw authFailure();
    let callback: URLSearchParams;
    try {
      callback = oauth.validateAuthResponse(definition.metadata, client, parameters, state.state);
    } catch (error) {
      await this.credentials.recover(ref, true, {
        initiator: { access, providerId: registrationId },
        finalize: async (tx) => {
          const current = await tx
            .selectFrom("authorizations")
            .select("state")
            .where("id", "=", attempt.id)
            .forUpdate()
            .executeTakeFirstOrThrow();
          if (current.state !== "pending") stale();
          await tx
            .updateTable("authorizations")
            .set({ state: "failed", protected_state: null, browser_verifier: null })
            .where("id", "=", attempt.id)
            .where("state", "=", "pending")
            .execute();
        },
      });
      throw error;
    }
    const claim = await this.credentials.claim(
      access,
      registrationId,
      ref,
      this.incarnation,
      this.leaseMs,
      async (tx) => {
        const current = await tx
          .selectFrom("authorizations")
          .selectAll()
          .where("id", "=", attempt.id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (
          current.state !== "pending" ||
          !current.launched ||
          !current.browser_verifier ||
          !verifySecret(browserSecret, current.browser_verifier) ||
          current.expires_at <= (await databaseTime(tx))
        )
          throw authFailure();
        await tx
          .updateTable("authorizations")
          .set({ state: "exchanging" })
          .where("id", "=", attempt.id)
          .execute();
      },
    );
    const protocol = providerProtocol(provider, this.policy).open(signal);
    try {
      await this.credentials.dispatch(
        access,
        registrationId,
        ref,
        claim,
        definition.exchangeMayInvalidate,
      );
      const tokenResponse = await oauth.authorizationCodeGrantRequest(
        definition.metadata,
        client,
        definition.clientSecret ? oauth.ClientSecretPost(definition.clientSecret) : oauth.None(),
        callback,
        definition.callbackUri,
        definition.pkce ? state.codeVerifier : oauth.nopkce,
        { [oauth.customFetch]: protocol.fetch, signal },
      );
      if (!tokenResponse.ok)
        throw new ServiceError(
          422,
          "provider-authorization-failed",
          "Provider authorization failed",
        );
      const candidate = await definition.parseTokenResponse(await protocolJson(tokenResponse), {
        renewal: false,
        request: (url, init) => protocol.fetch(url, init),
      });
      signal.throwIfAborted();
      await this.credentials.publish(
        access,
        provider,
        ref,
        claim,
        candidate,
        async (tx, connection) => {
          if (attempt.operator_context)
            await this.operators!.publishAudience(
              tx,
              connection.id,
              attempt.operator_context.audience,
            );
          const current = await tx
            .selectFrom("authorizations")
            .selectAll()
            .where("id", "=", attempt.id)
            .forUpdate()
            .executeTakeFirstOrThrow();
          if (current.state !== "exchanging" || current.expires_at <= (await databaseTime(tx)))
            stale();
          await tx
            .updateTable("authorizations")
            .set({
              state: "succeeded",
              connection_id: connection.id,
              protected_state: null,
              browser_verifier: null,
            })
            .where("id", "=", attempt.id)
            .execute();
        },
      );
      return attempt.id;
    } catch (error) {
      await this.credentials.recover(ref, true, {
        initiator: { access, providerId: registrationId },
        finalize: async (tx) => {
          await tx
            .updateTable("authorizations")
            .set({ state: "failed", protected_state: null, browser_verifier: null })
            .where("id", "=", attempt.id)
            .where("state", "=", "exchanging")
            .execute();
        },
      });
      throw error;
    } finally {
      await protocol.dispose();
    }
  }
  async cancel(access: AccessContext, id: string): Promise<AuthorizationView> {
    const current = await this.load(id);
    if (current.access.ownerId !== access.ownerId || current.access.sessionId !== access.sessionId)
      absent();
    await this.credentials.recover(current.ref, true, {
      initiator: { access, providerId: current.attempt.provider_registration_id },
      finalize: async (tx) => {
        await tx
          .updateTable("authorizations")
          .set({ state: "cancelled", protected_state: null, browser_verifier: null })
          .where("id", "=", id)
          .where("state", "in", ["pending", "exchanging"])
          .execute();
      },
    });
    return this.view(access, id);
  }
}
