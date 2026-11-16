import { readFileSync } from "node:fs";
import { z } from "zod";
import { type FieldError, ServiceError } from "./errors.ts";
import { fieldErrors } from "./validation.ts";

export type SealingKeys = { current: string; keys: Map<string, Buffer> };

export type Settings = {
  databaseUrl: string;
  databaseCaCert: string | undefined;
  sealingKeys: SealingKeys;
  /** From PUBLIC_ORIGIN; bootstrap may supply it instead (see resolveInstallation). */
  publicOrigin: string | undefined;
  bootstrapPath: string;
  redisUrl: string | undefined;
  port: number;
  workerHealthPort: number;
  /** From SIGN_IN_LIMIT; bootstrap may supply it instead (see resolveInstallation). */
  signInLimitSeconds: number | undefined;
  jobInputCap: number;
  jobResultCap: number;
  jobRuntimeCapSeconds: number;
  jobResultRetentionSeconds: number;
  jobRecordRetentionSeconds: number;
  workerConcurrency: number;
  upstreamConnectTimeoutMs: number;
  upstreamHeadersTimeoutMs: number;
  upstreamIdleTimeoutMs: number;
};

const MB = 1024 * 1024;
const DAY = 86_400;

/** An origin with no path, query, fragment or credentials. HTTPS, or HTTP on loopback for development. */
export function canonicalOrigin(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return undefined;
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    return undefined;
  if (value.replace(/\/$/, "") !== url.origin) return undefined;
  return url.origin;
}

const positiveInt = (rule: string) =>
  z
    .string()
    .regex(/^\d+$/, rule)
    .transform(Number)
    .refine((n) => Number.isSafeInteger(n) && n >= 1, rule);

const port = z
  .string()
  .regex(/^\d+$/, "port")
  .transform(Number)
  .refine((n) => n >= 0 && n <= 65535, "port");

const sealingKeys = z.string().transform((value, ctx): SealingKeys => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "json:{current,keys}" });
    return z.NEVER;
  }
  const shape = z
    .strictObject({
      current: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "key-id"),
      keys: z.record(z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "key-id"), z.string()),
    })
    .safeParse(parsed);
  if (!shape.success) {
    ctx.addIssue({ code: "custom", message: "json:{current,keys}" });
    return z.NEVER;
  }
  const keys = new Map<string, Buffer>();
  for (const [id, encoded] of Object.entries(shape.data.keys)) {
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32 || key.toString("base64") !== encoded.replace(/\s/g, "")) {
      ctx.addIssue({ code: "custom", message: "key:base64-256-bit", path: [id] });
      return z.NEVER;
    }
    keys.set(id, key);
  }
  if (!keys.has(shape.data.current)) {
    ctx.addIssue({ code: "custom", message: "current-key-present", path: ["current"] });
    return z.NEVER;
  }
  return { current: shape.data.current, keys };
});

const schema = z.object({
  DATABASE_URL: z
    .string({ error: "required" })
    .refine((v) => /^postgres(ql)?:\/\//.test(v), "postgres-url"),
  DATABASE_CA_CERT: z.string().optional(),
  SEALING_KEYS: sealingKeys,
  PUBLIC_ORIGIN: z
    .string()
    .refine((v) => canonicalOrigin(v) !== undefined, "https-origin")
    .optional(),
  BOOTSTRAP: z.string({ error: "required" }).min(1, "required"),
  REDIS_URL: z
    .string()
    .refine((v) => /^rediss?:\/\//.test(v), "redis-url")
    .optional(),
  PORT: port.default(3000),
  WORKER_HEALTH_PORT: port.default(3001),
  SIGN_IN_LIMIT: positiveInt("seconds").optional(),
  JOB_INPUT_CAP: positiveInt("bytes").default(100 * MB),
  JOB_RESULT_CAP: positiveInt("bytes").default(100 * MB),
  JOB_RUNTIME_CAP: positiveInt("seconds").default(DAY),
  JOB_RESULT_RETENTION: positiveInt("seconds").default(7 * DAY),
  JOB_RECORD_RETENTION: positiveInt("seconds").default(30 * DAY),
  WORKER_CONCURRENCY: positiveInt("integer>=1").default(4),
  UPSTREAM_CONNECT_TIMEOUT: positiveInt("milliseconds").default(10_000),
  UPSTREAM_HEADERS_TIMEOUT: positiveInt("milliseconds").default(120_000),
  UPSTREAM_IDLE_TIMEOUT: positiveInt("milliseconds").default(120_000),
});

/** Reads settings from the environment. Every failing field is listed with its rule, never its value. */
export function loadSettings(env: Record<string, string | undefined> = process.env): Settings {
  const input = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ""),
  );
  const parsed = schema.safeParse(input);
  const fields: FieldError[] = parsed.success ? [] : fieldErrors(parsed.error);
  let ca: string | undefined;
  if (parsed.success && parsed.data.DATABASE_CA_CERT !== undefined) {
    const value = parsed.data.DATABASE_CA_CERT;
    if (value.includes("-----BEGIN CERTIFICATE-----")) ca = value;
    else {
      try {
        ca = readFileSync(value, "utf8");
        if (!ca.includes("-----BEGIN CERTIFICATE-----"))
          fields.push({ path: "DATABASE_CA_CERT", rule: "pem-certificate" });
      } catch {
        fields.push({ path: "DATABASE_CA_CERT", rule: "readable-file-or-pem" });
      }
    }
  }
  if (!parsed.success || fields.length)
    throw new ServiceError(500, "invalid-settings", "Service settings are invalid", { fields });
  const d = parsed.data;
  return {
    databaseUrl: d.DATABASE_URL,
    databaseCaCert: ca,
    sealingKeys: d.SEALING_KEYS,
    publicOrigin: d.PUBLIC_ORIGIN === undefined ? undefined : canonicalOrigin(d.PUBLIC_ORIGIN),
    bootstrapPath: d.BOOTSTRAP,
    redisUrl: d.REDIS_URL,
    port: d.PORT,
    workerHealthPort: d.WORKER_HEALTH_PORT,
    signInLimitSeconds: d.SIGN_IN_LIMIT,
    jobInputCap: d.JOB_INPUT_CAP,
    jobResultCap: d.JOB_RESULT_CAP,
    jobRuntimeCapSeconds: d.JOB_RUNTIME_CAP,
    jobResultRetentionSeconds: d.JOB_RESULT_RETENTION,
    jobRecordRetentionSeconds: d.JOB_RECORD_RETENTION,
    workerConcurrency: d.WORKER_CONCURRENCY,
    upstreamConnectTimeoutMs: d.UPSTREAM_CONNECT_TIMEOUT,
    upstreamHeadersTimeoutMs: d.UPSTREAM_HEADERS_TIMEOUT,
    upstreamIdleTimeoutMs: d.UPSTREAM_IDLE_TIMEOUT,
  };
}

export const DEFAULT_SIGN_IN_LIMIT_SECONDS = 7 * DAY;

export type Installation = { publicOrigin: string; signInLimitSeconds: number };

/**
 * Combines host settings with bootstrap for the two values either may hold.
 * The public origin must come from one of them and, when both give it, they must agree.
 * SIGN_IN_LIMIT overrides the bootstrap sign-in limit, which overrides the seven-day default.
 */
export function resolveInstallation(
  settings: Pick<Settings, "publicOrigin" | "signInLimitSeconds">,
  bootstrap: { publicOrigin?: string | undefined; signInLimit?: number | undefined },
): Installation {
  const fromBootstrap =
    bootstrap.publicOrigin === undefined ? undefined : canonicalOrigin(bootstrap.publicOrigin);
  const publicOrigin = settings.publicOrigin ?? fromBootstrap;
  const fields: FieldError[] = [];
  if (!publicOrigin) fields.push({ path: "PUBLIC_ORIGIN", rule: "required" });
  else if (settings.publicOrigin && fromBootstrap && settings.publicOrigin !== fromBootstrap)
    fields.push({ path: "PUBLIC_ORIGIN", rule: "matches-bootstrap.publicOrigin" });
  if (fields.length)
    throw new ServiceError(500, "invalid-settings", "Service settings are invalid", { fields });
  return {
    publicOrigin: publicOrigin as string,
    signInLimitSeconds:
      settings.signInLimitSeconds ?? bootstrap.signInLimit ?? DEFAULT_SIGN_IN_LIMIT_SECONDS,
  };
}
