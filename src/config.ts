import { z } from "zod";

const positive = (fallback?: number) =>
  z.coerce
    .number()
    .int()
    .positive()
    .safe()
    .default(fallback ?? 1);
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  DATABASE_URL: z.url(),
  CONTROL_DATABASE_URL: z.url().optional(),
  SERVICE_ORIGIN: z.url(),
  PORT: positive(3000),
  WORKER_HEALTH_PORT: positive(3001),
  HOST: z.string().default("127.0.0.1"),
  DB_POOL_MAX: positive(5),
  DB_CONTROL_POOL_MAX: positive(2),
  DB_ACQUIRE_TIMEOUT_MS: positive(5000),
  DB_STATEMENT_TIMEOUT_MS: positive(10000),
  DB_LOCK_TIMEOUT_MS: positive(2000),
  SESSION_MAX_AGE_SECONDS: positive(604800),
  ACCESS_TOKEN_AGE_SECONDS: positive(900),
  ENCRYPTION_ACTIVE_KEY_ID: z.string().min(1).max(100),
  ENCRYPTION_KEYS: z.string(),
});
export type Config = ReturnType<typeof loadConfig>;
export function loadConfig(env: NodeJS.ProcessEnv) {
  const config = envSchema.parse(env);
  const url = new URL(config.SERVICE_ORIGIN);
  if (
    url.origin !== config.SERVICE_ORIGIN ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(config.NODE_ENV !== "production" && url.hostname === "127.0.0.1"))
  )
    throw new Error("SERVICE_ORIGIN must be a canonical HTTPS origin");
  if (config.ACCESS_TOKEN_AGE_SECONDS > config.SESSION_MAX_AGE_SECONDS)
    throw new Error("Access lifetime exceeds fixed session lifetime");
  const rawKeys = z
    .record(z.string().min(1).max(100), z.string().regex(/^[a-f0-9]{64}$/i))
    .parse(JSON.parse(config.ENCRYPTION_KEYS));
  const keys = new Map(Object.entries(rawKeys).map(([id, hex]) => [id, Buffer.from(hex, "hex")]));
  if (!keys.has(config.ENCRYPTION_ACTIVE_KEY_ID)) throw new Error("Active encryption key missing");
  return { ...config, keys };
}
