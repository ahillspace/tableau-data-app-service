import type { z } from "zod";
import type { AccessContext, CoreServices, ProviderContext } from "../core-ports.js";
import type { CapabilityRef, JobView } from "../public/schemas.js";
import type { PayloadProcessor } from "./payloads.js";

export type OriginalAuthority = import("../core-ports.js").BackgroundScope;
export type JobError = { code: string; message: string };
export type CallbackBinding = Readonly<{ correlation: string; callbackUrl: string }>;
export interface JobContext extends ProviderContext {
  jobId: string;
  deadline: string;
  callbackBinding?: CallbackBinding;
  reportProgress(value: unknown): Promise<void>;
}
export type ExternalTask = { externalId: string; accountKey: string; context: unknown };
export type ObservationOutcome =
  | { kind: "pending"; nextCheckAt: string; progress?: unknown }
  | { kind: "succeeded"; result: unknown }
  | { kind: "failed"; error: JobError; result?: unknown };
export type ExecutionOutcome =
  | { kind: "complete"; result: unknown }
  | { kind: "waiting"; task: ExternalTask; nextCheckAt?: string }
  | { kind: "failed"; error: JobError; retryable?: boolean; result?: unknown };
export type CallbackEvidence = {
  correlation: string;
  task: ExternalTask;
  outcome: ObservationOutcome;
};
export type JobDeclaration = {
  ref: CapabilityRef;
  providerRegistrationId: string;
  inputSchema: z.ZodType;
  resultSchema: z.ZodType;
  progressSchema?: z.ZodType;
  inputLimitBytes?: number;
  resultLimitBytes?: number;
  executionLimitSeconds?: number;
  // Retain this schema/default contract while metadata remains, even if admission is disabled.
  acceptsSubmissions?: boolean;
  retry?: { delaysMs: readonly number[] };
  handler(input: unknown, context: JobContext): Promise<ExecutionOutcome>;
  external?: {
    contextSchema: z.ZodType;
    contextLimitBytes: number;
    observe?: (task: ExternalTask, context: JobContext) => Promise<ObservationOutcome>;
    cancel?: (
      task: ExternalTask,
      context: ProviderContext & { deadline: string },
    ) => Promise<"confirmed" | "unconfirmed">;
    callback?: {
      route: string;
      // Provider/source proof is checked here, before Jobs accepts the interpretation.
      verify(body: Uint8Array, headers: Headers): Promise<CallbackEvidence>;
    };
  };
};
export type JobHintPort = {
  disclose(access: AccessContext, jobId: string): Promise<{ id: string } | null>;
};
export type JobLimits = {
  inputBytes: number;
  resultBytes: number;
  executionSeconds: number;
  resultRetentionMs: number;
  metadataRetentionMs: number;
};
export type JobsOptions = {
  core: CoreServices;
  payloads: PayloadProcessor;
  declarations: readonly JobDeclaration[];
  limits?: Partial<JobLimits>;
  callbackOrigin: string;
  onHint?: (jobId: string, revision: number) => void;
};
export type JobState = JobView["state"];
