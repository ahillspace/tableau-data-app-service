import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export type RemoteFilesConfiguration = {
  backend: "s3" | "gcs";
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
  forcePathStyle: boolean;
  ca?: string | undefined;
};

export type FilesConfiguration =
  | RemoteFilesConfiguration
  | { backend: "local"; root: string }
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
const localKeys = ["FILES_LOCAL_ROOT"] as const;
const bucketPattern = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const shortBucketPattern = /^[a-z0-9]{3}$/;
const gcsBucketPattern = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;

/** Optional Files object storage. Misconfiguration must not stop native routing. */
export function filesConfiguration(
  env: Record<string, string | undefined>,
): FilesConfiguration | undefined {
  if (![...s3Keys, ...gcsKeys, ...localKeys, "FILES_BACKEND"].some((key) => env[key]))
    return undefined;
  const selector = env.FILES_BACKEND;
  if (selector !== undefined && selector !== "s3" && selector !== "gcs" && selector !== "local")
    return { reason: "FILES_BACKEND must be s3, gcs or local" };
  const presentS3 = s3Keys.filter((key) => env[key]);
  const presentGcs = gcsKeys.filter((key) => env[key]);
  const presentLocal = localKeys.filter((key) => env[key]);
  const present = [...presentS3, ...presentGcs, ...presentLocal];
  const groups = [presentS3, presentGcs, presentLocal].filter((keys) => keys.length > 0);
  if (groups.length > 1)
    return { reason: `Files backends cannot be mixed; ${present.join(", ")} are set` };
  const configured =
    presentS3.length > 0
      ? "s3"
      : presentGcs.length > 0
        ? "gcs"
        : presentLocal.length > 0
          ? "local"
          : undefined;
  if (selector !== undefined && configured && configured !== selector)
    return { reason: `FILES_BACKEND=${selector} conflicts with ${present.join(", ")}` };
  const backend = selector ?? configured ?? "s3";
  if (backend === "local") {
    const root = env.FILES_LOCAL_ROOT;
    if (!root || !isAbsolute(root))
      return { reason: "FILES_LOCAL_ROOT must be an absolute directory path" };
    try {
      if (!statSync(root).isDirectory())
        return { reason: "FILES_LOCAL_ROOT must be an existing directory" };
      accessSync(root, constants.R_OK | constants.W_OK | constants.X_OK);
      return { backend: "local", root: realpathSync(root) };
    } catch {
      return { reason: "FILES_LOCAL_ROOT must be an existing readable and writable directory" };
    }
  }
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
