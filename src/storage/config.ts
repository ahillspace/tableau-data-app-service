import { readFileSync } from "node:fs";
import pg from "pg";

export type StorageConfiguration =
  | { url: URL; ca: string | undefined; connections: number }
  | { reason: string };

/** Credentials do not identify a database; the driver's effective host, port and name do. */
function databaseIdentity(connectionString: string): string {
  const client = new pg.Client({ connectionString });
  const host = (client.host ?? "").toLowerCase().replace(/\.+$/, "");
  const port = client.port ?? 5432;
  const name = client.database ?? "";
  if (!host || !name || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid connection options");
  return `${host}:${port}/${name}`;
}

/** A misconfigured optional component must not stop native routing. */
export function storageConfiguration(
  env: Record<string, string | undefined>,
  coreUrl: string,
): StorageConfiguration | undefined {
  const raw = env.STORAGE_DATABASE_URL;
  if (!raw && !env.STORAGE_DATABASE_CA_CERT && !env.STORAGE_WORKSPACE_CONNECTIONS) return undefined;
  let url: URL;
  try {
    url = new URL(raw ?? "");
    if (
      !/^postgres(ql)?:$/.test(url.protocol) ||
      !url.hostname ||
      !url.username ||
      !url.password ||
      !/^\/[^/]+$/.test(url.pathname) ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid URL");
    if (databaseIdentity(raw ?? "") === databaseIdentity(coreUrl))
      return {
        reason:
          "STORAGE_DATABASE_URL must name a dedicated Storage database distinct from DATABASE_URL",
      };
  } catch {
    return {
      reason: "STORAGE_DATABASE_URL must name the dedicated PostgreSQL database and provisioner",
    };
  }
  const budget = env.STORAGE_WORKSPACE_CONNECTIONS || "8";
  const connections = Number(budget);
  if (!/^\d+$/.test(budget) || connections < 1 || !Number.isSafeInteger(connections))
    return { reason: "STORAGE_WORKSPACE_CONNECTIONS must be a positive connection count" };
  let ca: string | undefined;
  const cert = env.STORAGE_DATABASE_CA_CERT;
  if (cert) {
    try {
      ca = cert.includes("-----BEGIN CERTIFICATE-----") ? cert : readFileSync(cert, "utf8");
      if (!ca.includes("-----BEGIN CERTIFICATE-----")) throw new Error("No certificate");
    } catch {
      return { reason: "STORAGE_DATABASE_CA_CERT must provide a readable PEM certificate" };
    }
  }
  return { url, ca, connections };
}
