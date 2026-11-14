import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Config } from "./config.js";
import { type InstalledDeclarations, installedDeclarations } from "./installed.js";
import { opaqueId } from "./public/schemas.js";

const positive = z.number().int().positive().safe();
const origin = z.url().refine((raw) => {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && raw === url.origin;
  } catch {
    return false;
  }
}, "Canonical HTTPS origin required");
const providerRegistrationSchema = z.strictObject({
  id: opaqueId,
  revision: positive,
  enabled: z.boolean(),
  mode: z.enum(["none", "personal", "operator"]),
  reauthSeconds: positive.nullable(),
});
export type ProviderRegistrationConfig = z.infer<typeof providerRegistrationSchema>;
const deployment = { id: opaqueId, revision: positive, enabled: z.boolean() };
export const applicationConfigSchema = z.strictObject({
  apps: z.array(
    z.strictObject({
      id: opaqueId,
      revision: positive,
      enabled: z.boolean(),
      defaults: z.record(opaqueId, opaqueId),
      corsOrigins: z.array(z.union([origin, z.literal("null")])),
    }),
  ),
  deployments: z.array(
    z.discriminatedUnion("kind", [
      z.strictObject({
        ...deployment,
        kind: z.literal("cloud"),
        podOrigin: origin,
        clientPath: z.string().regex(/^\/client-[A-Za-z0-9_-]+\.json$/),
      }),
      z.strictObject({
        ...deployment,
        kind: z.literal("server"),
        origin,
        targetSite: z.string().min(1),
        siteId: opaqueId,
        apiVersion: z.string().regex(/^3\.\d+$/),
        clientType: z.string().min(1),
        privateCidrs: z.array(z.string()),
        tlsCaFile: z.string().optional(),
      }),
    ]),
  ),
  providers: z.array(providerRegistrationSchema).default([]),
  slack: providerRegistrationSchema
    .extend({
      mode: z.enum(["personal", "operator"]),
      oauth: z
        .strictObject({
          clientId: z.string().min(1),
          clientSecretEnv: z.string().optional(),
          pkceEnabled: z.boolean(),
          tokenMode: z.enum(["bot", "user"]),
          scopes: z.array(z.string().min(1)).min(1),
        })
        .optional(),
    })
    .optional(),
  registryCredentials: z.array(
    z.strictObject({ actorId: opaqueId, verifier: z.string().regex(/^[a-f0-9]{64}$/) }),
  ),
  operatorCredentials: z
    .array(z.strictObject({ actorId: opaqueId, verifier: z.string().regex(/^[a-f0-9]{64}$/) }))
    .default([]),
  transport: z.strictObject({
    connectTimeoutMs: positive,
    headersTimeoutMs: positive,
    stallTimeoutMs: positive,
    maxSockets: positive,
    uploadLimitBytes: positive.optional(),
  }),
  jsonPreparationBytes: positive,
  maintenance: z.strictObject({
    scanMs: positive,
    batch: positive,
    operationMs: positive,
    leaseMs: positive,
    contentionMs: positive,
    cleanupMs: positive,
  }),
  worker: z.strictObject({
    executionSlots: positive,
    observationSlots: positive,
    batchSize: positive,
    leaseMs: positive,
    heartbeatMs: positive,
    scanMs: positive,
    heartbeatIntervalMs: positive,
    unresponsiveMs: positive,
    terminateGraceMs: positive,
  }),
  jobs: z.strictObject({ workingBytes: positive }),
  events: z
    .strictObject({
      channelScope: opaqueId,
      publishUrlEnv: z.string().min(1),
      subscribeUrlEnv: z.string().min(1),
      commandTimeoutMs: positive,
      limits: z.strictObject({
        payloadBytes: positive,
        maxAgeMs: positive,
        clockSkewMs: z.number().int().nonnegative().safe(),
        publisherBytes: positive,
        subscriberBytes: positive,
        streamBytes: positive,
        aggregateBytes: positive,
        stallMs: positive,
        heartbeatMs: positive,
      }),
    })
    .optional(),
});
export type ApplicationConfig = z.infer<typeof applicationConfigSchema>;
function protocolIdentity(item: ApplicationConfig["deployments"][number]): Record<string, string> {
  return item.kind === "cloud"
    ? { origin: item.podOrigin }
    : { origin: item.origin, siteId: item.siteId };
}
export async function readApplicationConfig(env: NodeJS.ProcessEnv): Promise<ApplicationConfig> {
  if (!env.SERVICE_CONFIG_FILE) throw new Error("SERVICE_CONFIG_FILE is required");
  const config = applicationConfigSchema.parse(
    JSON.parse(await readFile(env.SERVICE_CONFIG_FILE, "utf8")),
  );
  const roleVerifiers = [...config.registryCredentials, ...config.operatorCredentials].map(
    (item) => item.verifier,
  );
  if (new Set(roleVerifiers).size !== roleVerifiers.length)
    throw new Error("Administrative credentials must be unique and separate by role");
  for (const items of [config.apps, config.deployments, config.slack ? [config.slack] : []]) {
    const ids = items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate configured identifier");
  }
  const paths = config.deployments.flatMap((item) =>
    item.kind === "cloud" ? [item.clientPath] : [],
  );
  if (new Set(paths).size !== paths.length) throw new Error("Duplicate Cloud client metadata path");
  if (
    config.maintenance.leaseMs < config.maintenance.operationMs ||
    config.worker.unresponsiveMs <= config.worker.heartbeatIntervalMs ||
    config.worker.leaseMs <= config.worker.heartbeatMs
  )
    throw new Error("Invalid lifecycle timing relationship");
  return config;
}
export function requiredSecret(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error("Required configured secret is missing");
  return value;
}
// This inventory contains metadata only. Executable providers remain source-installed.
export function providerRegistrationInventory(
  config: ApplicationConfig,
  installed: InstalledDeclarations = installedDeclarations,
): readonly ProviderRegistrationConfig[] {
  const definitions = new Map(installed.providers.map((provider) => [provider.id, provider]));
  if (definitions.size !== installed.providers.length)
    throw new Error("Duplicate installed provider registration");
  for (const item of config.providers) {
    const definition = definitions.get(item.id);
    if (!definition || definition.revision !== item.revision || definition.mode !== item.mode)
      throw new Error("Configured provider differs from its trusted installed declaration");
  }
  if (
    installed.providers.some(
      (definition) => !config.providers.some((item) => item.id === definition.id),
    )
  )
    throw new Error("Installed provider has no registration configuration");
  const inventory: ProviderRegistrationConfig[] = [...config.providers];
  if (config.slack) {
    const { id, revision, enabled, mode, reauthSeconds } = config.slack;
    inventory.push({ id, revision, enabled, mode, reauthSeconds });
  }
  if (new Set(inventory.map((item) => item.id)).size !== inventory.length)
    throw new Error("Duplicate configured provider registration");
  return inventory;
}
export async function applyConfiguration(
  db: import("./db/database.js").Database,
  config: ApplicationConfig,
  installed: InstalledDeclarations = installedDeclarations,
): Promise<void> {
  const inventory = providerRegistrationInventory(config, installed);
  await db.transaction().execute(async (tx) => {
    for (const item of [...config.deployments].sort((a, b) => a.id.localeCompare(b.id))) {
      const adapterId = item.kind === "cloud" ? "tableau-cloud" : "tableau-server-reference";
      const previous = await tx
        .selectFrom("deployments")
        .selectAll()
        .where("id", "=", item.id)
        .forUpdate()
        .executeTakeFirst();
      if (previous && (previous.kind !== item.kind || previous.adapter_id !== adapterId))
        throw new Error("Deployment identity is immutable");
      if (previous && !isDeepStrictEqual(previous.protocol_identity, protocolIdentity(item))) {
        const owned = await tx
          .selectFrom("owners")
          .select("id")
          .where("deployment_id", "=", item.id)
          .limit(1)
          .executeTakeFirst();
        if (Object.keys(previous.protocol_identity).length || owned)
          throw new Error("Deployment URL continuity requires separately verified evidence");
      }
      await tx
        .insertInto("deployments")
        .values({
          id: item.id,
          kind: item.kind,
          adapter_id: adapterId,
          config_revision: item.revision,
          enabled: item.enabled,
          protocol_identity: protocolIdentity(item),
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            enabled: item.enabled,
            config_revision: item.revision,
            protocol_identity: protocolIdentity(item),
          }),
        )
        .execute();
    }
    for (const item of [...config.apps].sort((a, b) => a.id.localeCompare(b.id)))
      await tx
        .insertInto("apps")
        .values({
          id: item.id,
          enabled: item.enabled,
          config_revision: item.revision,
          defaults: item.defaults,
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            enabled: item.enabled,
            config_revision: item.revision,
            defaults: item.defaults,
          }),
        )
        .execute();
    for (const item of [...inventory].sort((a, b) => a.id.localeCompare(b.id))) {
      const previous = await tx
        .selectFrom("provider_registrations")
        .selectAll()
        .where("id", "=", item.id)
        .forUpdate()
        .executeTakeFirst();
      if (previous && previous.mode !== item.mode)
        throw new Error("Provider ownership mode is immutable");
      await tx
        .insertInto("provider_registrations")
        .values({
          id: item.id,
          enabled: item.enabled,
          config_revision: item.revision,
          mode: item.mode,
          reauth_seconds: item.reauthSeconds,
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            enabled: item.enabled,
            config_revision: item.revision,
            reauth_seconds: item.reauthSeconds,
          }),
        )
        .execute();
    }
  });
}
export async function assertConfiguration(
  db: import("./db/database.js").Database,
  config: ApplicationConfig,
  _base: Config,
  installed: InstalledDeclarations = installedDeclarations,
): Promise<void> {
  const inventory = providerRegistrationInventory(config, installed);
  const [apps, deployments, providers] = await Promise.all([
    db.selectFrom("apps").selectAll().where("enabled", "=", true).execute(),
    db.selectFrom("deployments").selectAll().where("enabled", "=", true).execute(),
    db.selectFrom("provider_registrations").selectAll().where("enabled", "=", true).execute(),
  ]);
  if (
    apps.some(
      (row) =>
        !config.apps.some(
          (item) =>
            item.enabled &&
            item.id === row.id &&
            item.revision === row.config_revision &&
            isDeepStrictEqual(item.defaults, row.defaults),
        ),
    ) ||
    deployments.some(
      (row) =>
        !config.deployments.some(
          (item) =>
            item.enabled &&
            item.id === row.id &&
            item.revision === row.config_revision &&
            item.kind === row.kind &&
            isDeepStrictEqual(protocolIdentity(item), row.protocol_identity),
        ),
    ) ||
    providers.some(
      (row) =>
        !inventory.some(
          (item) =>
            item.id === row.id &&
            item.enabled &&
            item.revision === row.config_revision &&
            item.mode === row.mode &&
            item.reauthSeconds === row.reauth_seconds,
        ),
    ) ||
    config.apps.filter((item) => item.enabled).length !== apps.length ||
    config.deployments.filter((item) => item.enabled).length !== deployments.length ||
    inventory.filter((item) => item.enabled).length !== providers.length
  )
    throw new Error("Installed configuration differs from enabled database configuration");
}
