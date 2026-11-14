import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  CLOUD_METADATA,
  CloudIdentityAdapter,
  type IdentityAdapter,
  IdentityProtocol,
  ServerIdentityAdapter,
} from "./access/adapters.js";
import { AccessService } from "./access/service.js";
import { SessionService } from "./access/sessions.js";
import { registerSiteRoutes } from "./access/sites.js";
import {
  type ApplicationConfig,
  assertConfiguration,
  requiredSecret,
} from "./application-config.js";
import type { Config } from "./config.js";
import { AuthorizationService } from "./connections/authorizations.js";
import { CredentialsService } from "./connections/credentials.js";
import { CoreMaintenance } from "./connections/maintenance.js";
import { OperatorConnections } from "./connections/operator.js";
import { Renewals } from "./connections/renewals.js";
import { ConnectionService } from "./connections/service.js";
import type { CoreServices } from "./core-ports.js";
import { assertSchema, createDatabase } from "./db/database.js";
import {
  createEventsExtension,
  type EventProvider,
  SourceMaintenance,
  Sources,
} from "./events/index.js";
import { createHttpApp } from "./http/app.js";
import { registerAuthorizationRoutes } from "./http/authorization-routes.js";
import { registerCoreRoutes } from "./http/core-routes.js";
import { registerOperatorRoutes } from "./http/operator-routes.js";
import { registerSessionRoutes } from "./http/session-routes.js";
import { jobsApi } from "./jobs/api.js";
import { jobLimitsFromEnvironment } from "./jobs/config.js";
import { PayloadProcessor } from "./jobs/payloads.js";
import { JobsService } from "./jobs/service.js";
import type { JobDeclaration } from "./jobs/types.js";
import { type ProviderRegistration, ProviderRegistry } from "./providers/registry.js";
import { slackRegistration } from "./providers/slack.js";
import { SecretBox } from "./security/encryption.js";
import { verifyProtectedKeys } from "./security/records.js";

// Additional trusted declarations are installed in source. The browser and
// configuration files cannot load modules, select fixture identities or add Jobs.
export type InstalledDeclarations = {
  providers: readonly ProviderRegistration[];
  jobs: readonly JobDeclaration[];
  events: ReadonlyMap<string, EventProvider>;
};
export const installedDeclarations: InstalledDeclarations = {
  providers: [],
  jobs: [],
  events: new Map(),
};

export async function createApplication(
  base: Config,
  settings: ApplicationConfig,
  env: NodeJS.ProcessEnv,
  installed: InstalledDeclarations = installedDeclarations,
) {
  const db = createDatabase(base),
    controlDb = createDatabase(base, true);
  let payloads: PayloadProcessor | undefined;
  let app: Awaited<ReturnType<typeof createHttpApp>> | undefined;
  try {
    await assertSchema(db);
    await assertConfiguration(db, settings, base);
    const { uploadLimitBytes, ...transportTimes } = settings.transport;
    const policy = {
      ...transportTimes,
      ...(uploadLimitBytes === undefined ? {} : { uploadLimitBytes }),
    };
    const secrets = new SecretBox(base.ENCRYPTION_ACTIVE_KEY_ID, base.keys);
    await verifyProtectedKeys(db, secrets, base.keys, settings.jobs.workingBytes);
    const access = new AccessService(db, base);
    const declarations = [...installed.providers];
    if (settings.slack) {
      const config = settings.slack;
      const provider = slackRegistration({
        id: config.id,
        mode: config.mode,
        ...(config.oauth
          ? {
              oauth: {
                ...config.oauth,
                callbackUri: `${base.SERVICE_ORIGIN}/v1/authorizations/callback/${config.id}`,
                ...(config.oauth.clientSecretEnv
                  ? { clientSecret: requiredSecret(env, config.oauth.clientSecretEnv) }
                  : {}),
              },
            }
          : {}),
      });
      provider.revision = config.revision;
      declarations.push(provider);
    }
    const providers = new ProviderRegistry(declarations);
    let sources: Sources | undefined;
    const retire = async (...args: Parameters<Sources["retireConnection"]>) =>
      sources?.retireConnection(...args);
    const connections = new ConnectionService(db, access, secrets, providers, policy, retire);
    const credentials = new CredentialsService(db, access, secrets, retire);
    const renewals = new Renewals(connections, credentials, settings.maintenance);
    connections.installRenewal((...args) => renewals.renew(...args));
    const core: CoreServices = { db, controlDb, secrets, access, connections };
    sources = new Sources(core, installed.events);
    connections.registerAuthority("event-source", sources.backgroundAuthority());
    const maintenance = new CoreMaintenance(
      controlDb,
      new CredentialsService(controlDb, new AccessService(controlDb, base), secrets, retire),
      settings.maintenance.batch,
    );
    await maintenance.run(new AbortController().signal);
    const adapters = new Map<string, IdentityAdapter>();
    for (const config of settings.deployments) {
      if (config.kind === "cloud") {
        const protocol = new IdentityProtocol(
          policy,
          new Map([
            [CLOUD_METADATA.issuer, { baseUrl: CLOUD_METADATA.issuer }],
            [config.podOrigin, { baseUrl: config.podOrigin }],
          ]),
        );
        adapters.set(
          config.id,
          new CloudIdentityAdapter(
            config.id,
            `${base.SERVICE_ORIGIN}/v1/session/callback/tableau-cloud`,
            `${base.SERVICE_ORIGIN}${config.clientPath}`,
            config.podOrigin,
            protocol,
          ),
        );
      } else {
        const endpoint = {
          baseUrl: config.origin,
          privateCidrs: config.privateCidrs,
          ...(config.tlsCaFile ? { tlsCa: await readFile(config.tlsCaFile, "utf8") } : {}),
        };
        adapters.set(
          config.id,
          new ServerIdentityAdapter(
            config.id,
            `${base.SERVICE_ORIGIN}/Callback`,
            config.origin,
            config.targetSite,
            config.siteId,
            config.apiVersion,
            config.clientType,
            new IdentityProtocol(policy, new Map([[config.origin, endpoint]])),
          ),
        );
      }
    }
    const sessions = new SessionService(
      db,
      access,
      secrets,
      adapters,
      settings.maintenance.operationMs,
    );
    const operators = new OperatorConnections(
      db,
      credentials,
      providers,
      policy,
      settings.maintenance,
      new Set(settings.operatorCredentials.map((item) => item.actorId)),
    );
    const authorizations = new AuthorizationService(
      db,
      access,
      credentials,
      providers,
      secrets,
      policy,
      settings.maintenance.operationMs,
      settings.maintenance.leaseMs,
      operators,
    );
    let jobs: JobsService | undefined;
    const events = createEventsExtension(
      settings.events
        ? {
            enabled: true,
            redis: {
              channelScope: settings.events.channelScope,
              publishUrl: requiredSecret(env, settings.events.publishUrlEnv),
              subscribeUrl: requiredSecret(env, settings.events.subscribeUrlEnv),
              commandTimeoutMs: settings.events.commandTimeoutMs,
            },
            limits: settings.events.limits,
            providers: installed.events,
            discloseJob: (context, id) =>
              jobs ? jobs.disclose(context, id) : Promise.resolve(null),
          }
        : { enabled: false },
    );
    const jobsRequired =
      installed.jobs.some((item) => item.acceptsSubmissions !== false) ||
      !!(await db
        .withTables<Pick<import("./jobs/database.js").JobsDatabase, "jobs">>()
        .selectFrom("jobs")
        .select("id")
        .limit(1)
        .executeTakeFirst());
    if (jobsRequired) {
      payloads = new PayloadProcessor({
        keyId: base.ENCRYPTION_ACTIVE_KEY_ID,
        keys: base.keys,
        workingBytes: settings.jobs.workingBytes,
      });
      jobs = new JobsService({
        core,
        payloads,
        declarations: installed.jobs,
        callbackOrigin: base.SERVICE_ORIGIN,
        limits: jobLimitsFromEnvironment(env),
        onHint: (id, revision) => {
          void events.publishJobHint(id, revision);
        },
      });
      await jobs.assertCompatibility();
      connections.registerAuthority("job", jobs);
      connections.registerAuthority("remote-cancel", jobs);
    }
    app = await createHttpApp({
      db,
      core,
      extensions: [
        events,
        ...(jobs ? [jobsApi(jobs, { cleanupMs: settings.maintenance.cleanupMs })] : []),
      ],
    });
    // Use the same Sources instance registered by Events when enabled.
    if (events.sources) sources = events.sources;
    registerCoreRoutes(app, {
      access,
      connections,
      credentials,
      providers,
      corsOrigins: [
        ...new Set(
          settings.apps.filter((item) => item.enabled).flatMap((item) => item.corsOrigins),
        ),
      ],
      jsonPreparationBytes: settings.jsonPreparationBytes,
      ...(settings.events ? { eventPayloadBytes: settings.events.limits.payloadBytes } : {}),
    });
    registerSessionRoutes(app, sessions, base.SERVICE_ORIGIN);
    registerAuthorizationRoutes(app, authorizations, base.SERVICE_ORIGIN);
    registerSiteRoutes(app, db, settings.registryCredentials);
    registerOperatorRoutes(app, operators, authorizations, settings.operatorCredentials);
    for (const config of settings.deployments)
      if (config.kind === "cloud") {
        app.get(config.clientPath, async () => ({
          client_id: `${base.SERVICE_ORIGIN}${config.clientPath}`,
          client_name: "Data App integration service",
          redirect_uris: [`${base.SERVICE_ORIGIN}/v1/session/callback/tableau-cloud`],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: "openid email",
        }));
      }
    let closing = false;
    return {
      app,
      core,
      connections,
      credentials,
      providers,
      sessions,
      authorizations,
      sources,
      events,
      jobs,
      jobsRequired,
      maintenance,
      sourceMaintenance: (requestTermination: (reason: string) => void) =>
        new SourceMaintenance(sources!, {
          incarnation: randomUUID(),
          leaseMs: settings.maintenance.leaseMs,
          cleanupMs: settings.maintenance.cleanupMs,
          requestTermination,
        }),
      async close() {
        if (closing) return;
        closing = true;
        await app!.close();
        await payloads?.close();
        await Promise.all([db.destroy(), controlDb.destroy()]);
      },
    };
  } catch (error) {
    await app?.close();
    await payloads?.close();
    await Promise.all([db.destroy(), controlDb.destroy()]);
    throw error;
  }
}
