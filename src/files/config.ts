import { readFileSync } from "node:fs";

export type FilesConfiguration =
  | {
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string | undefined;
      forcePathStyle: boolean;
      ca?: string | undefined;
    }
  | { reason: string };

/** Optional Files object storage. Misconfiguration must not stop native routing. */
export function filesConfiguration(
  env: Record<string, string | undefined>,
): FilesConfiguration | undefined {
  const keys = [
    "FILES_S3_ENDPOINT",
    "FILES_S3_REGION",
    "FILES_S3_BUCKET",
    "FILES_S3_ACCESS_KEY_ID",
    "FILES_S3_SECRET_ACCESS_KEY",
    "FILES_S3_SESSION_TOKEN",
    "FILES_S3_FORCE_PATH_STYLE",
    "FILES_S3_CA_CERT",
  ] as const;
  if (!keys.some((key) => env[key])) return undefined;
  const endpoint = env.FILES_S3_ENDPOINT;
  const region = env.FILES_S3_REGION ?? "us-east-1";
  const bucket = env.FILES_S3_BUCKET;
  const accessKeyId = env.FILES_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.FILES_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    return {
      reason:
        "FILES_S3_ENDPOINT, FILES_S3_BUCKET, FILES_S3_ACCESS_KEY_ID and FILES_S3_SECRET_ACCESS_KEY are required when Files is enabled",
    };
  }
  let url: URL;
  try {
    url = new URL(endpoint);
    if (!/^https?:$/.test(url.protocol) || !url.hostname) throw new Error("bad endpoint");
  } catch {
    return { reason: "FILES_S3_ENDPOINT must be an HTTP(S) endpoint" };
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) && !/^[a-z0-9]{3}$/.test(bucket)) {
    return { reason: "FILES_S3_BUCKET must be a valid S3 bucket name" };
  }
  const forcePathStyle = (env.FILES_S3_FORCE_PATH_STYLE ?? "true") !== "false";
  let ca: string | undefined;
  const cert = env.FILES_S3_CA_CERT;
  if (cert) {
    try {
      ca = cert.includes("-----BEGIN CERTIFICATE-----") ? cert : readFileSync(cert, "utf8");
      if (!ca.includes("-----BEGIN CERTIFICATE-----")) throw new Error("No certificate");
    } catch {
      return { reason: "FILES_S3_CA_CERT must provide a readable PEM certificate" };
    }
  }
  return {
    endpoint: url.href.replace(/\/$/, ""),
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    ...(env.FILES_S3_SESSION_TOKEN ? { sessionToken: env.FILES_S3_SESSION_TOKEN } : {}),
    forcePathStyle,
    ...(ca ? { ca } : {}),
  };
}
