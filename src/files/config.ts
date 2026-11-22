import { readFileSync } from "node:fs";

export type FilesConfiguration =
  | {
      backend: "s3" | "gcs";
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

const s3Keys = [
  "FILES_S3_ENDPOINT",
  "FILES_S3_REGION",
  "FILES_S3_BUCKET",
  "FILES_S3_ACCESS_KEY_ID",
  "FILES_S3_SECRET_ACCESS_KEY",
  "FILES_S3_SESSION_TOKEN",
  "FILES_S3_FORCE_PATH_STYLE",
  "FILES_S3_CA_CERT",
] as const;
const gcsKeys = [
  "FILES_GCS_BUCKET",
  "FILES_GCS_ACCESS_KEY_ID",
  "FILES_GCS_SECRET_ACCESS_KEY",
] as const;
const bucketPattern = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const shortBucketPattern = /^[a-z0-9]{3}$/;
const gcsBucketPattern = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;

/** Optional Files object storage. Misconfiguration must not stop native routing. */
export function filesConfiguration(
  env: Record<string, string | undefined>,
): FilesConfiguration | undefined {
  if (![...s3Keys, ...gcsKeys, "FILES_BACKEND"].some((key) => env[key])) return undefined;
  const selector = env.FILES_BACKEND;
  if (selector !== undefined && selector !== "s3" && selector !== "gcs")
    return { reason: "FILES_BACKEND must be s3 or gcs" };
  const presentS3 = s3Keys.filter((key) => env[key]);
  const presentGcs = gcsKeys.filter((key) => env[key]);
  if (presentS3.length > 0 && presentGcs.length > 0)
    return {
      reason: `Files backends cannot be mixed; ${[...presentS3, ...presentGcs].join(", ")} are set`,
    };
  if (selector === "s3" && presentGcs.length > 0)
    return { reason: `FILES_BACKEND=s3 conflicts with ${presentGcs.join(", ")}` };
  if (selector === "gcs" && presentS3.length > 0)
    return { reason: `FILES_BACKEND=gcs conflicts with ${presentS3.join(", ")}` };
  const backend = selector ?? (presentGcs.length > 0 ? "gcs" : "s3");
  if (backend === "gcs") {
    const missing = gcsKeys.filter((key) => !env[key]);
    if (missing.length > 0)
      return { reason: `${missing.join(", ")} are required when FILES_BACKEND=gcs` };
    const bucket = env.FILES_GCS_BUCKET ?? "";
    if (!gcsBucketPattern.test(bucket))
      return { reason: "FILES_GCS_BUCKET must be a valid GCS bucket name" };
    return {
      backend: "gcs",
      endpoint: "https://storage.googleapis.com",
      region: "auto",
      bucket,
      accessKeyId: env.FILES_GCS_ACCESS_KEY_ID ?? "",
      secretAccessKey: env.FILES_GCS_SECRET_ACCESS_KEY ?? "",
      forcePathStyle: true,
    };
  }
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
  if (!bucketPattern.test(bucket) && !shortBucketPattern.test(bucket)) {
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
    backend: "s3",
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
