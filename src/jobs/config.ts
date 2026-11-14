import { z } from "zod";
import type { JobLimits } from "./types.js";

export function jobLimitsFromEnvironment(env: NodeJS.ProcessEnv = process.env): JobLimits {
  const settings = z
    .object({
      JOB_INPUT_MAX_BYTES: z.coerce.number().int().positive().max(100000000).default(100000000),
      JOB_RESULT_MAX_BYTES: z.coerce.number().int().positive().max(100000000).default(100000000),
      JOB_EXECUTION_MAX_SECONDS: z.coerce.number().int().positive().max(86400).default(86400),
      JOB_RESULT_RETENTION_SECONDS: z.coerce
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER / 1000)
        .default(604800),
      JOB_METADATA_RETENTION_SECONDS: z.coerce
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER / 1000)
        .default(2592000),
    })
    .parse(env);
  if (settings.JOB_RESULT_RETENTION_SECONDS > settings.JOB_METADATA_RETENTION_SECONDS)
    throw new Error("Job results cannot outlive metadata");
  return {
    inputBytes: settings.JOB_INPUT_MAX_BYTES,
    resultBytes: settings.JOB_RESULT_MAX_BYTES,
    executionSeconds: settings.JOB_EXECUTION_MAX_SECONDS,
    resultRetentionMs: settings.JOB_RESULT_RETENTION_SECONDS * 1000,
    metadataRetentionMs: settings.JOB_METADATA_RETENTION_SECONDS * 1000,
  };
}
