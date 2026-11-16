import type { Identity } from "../identity/types.ts";
import type { JobStateColumn } from "../persistence/schema.ts";
import type { ServiceErrorBody } from "../platform/errors.ts";

export type JobState = JobStateColumn;

export const FINISHED_STATES: readonly JobState[] = [
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
];

/** A Job as its owner and operators read it. Input and result are read separately. */
export type Job = {
  id: string;
  handler: string;
  definitionId: string;
  owner: Identity;
  appId: string;
  submissionKey: string;
  state: JobState;
  attempt: number;
  progress?: unknown;
  externalTaskId?: string;
  cancelRequested: boolean;
  /** True when the provider may have acted on work that did not finish normally. */
  remoteEffectsUnknown: boolean;
  result?: { available: boolean; expiresAt: string };
  error?: ServiceErrorBody["error"];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};

export type JobLimits = {
  inputBytes: number;
  resultBytes: number;
  runtimeSeconds: number;
  resultRetentionSeconds: number;
  recordRetentionSeconds: number;
};

export type Submission = {
  handler: string;
  definitionId: string;
  input: unknown;
  submissionKey: string;
};
