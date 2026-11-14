import type { Kysely, Selectable, Transaction } from "kysely";
import type { CoreDatabase, Json, Timestamp } from "../db/schema.js";
import type { JobState } from "./types.js";

export interface JobsTable {
  id: string;
  app_id: string;
  owner_id: string;
  deployment_id: string;
  site_id: string;
  subject_id: string;
  submission_id: string;
  capability_id: string;
  capability_version: number;
  provider_registration_id: string;
  provider_revision: number;
  connection_id: string | null;
  authority_generation: number | null;
  account_key: string | null;
  comparison_version: number;
  comparison_digest: string;
  comparison_schema: Json<object>;
  input_limit: number;
  result_limit: number;
  execution_seconds: number;
  result_retention_ms: number;
  metadata_retention_ms: number;
  state: JobState;
  revision: number;
  submitted_at: Timestamp;
  started_at: Timestamp | null;
  deadline: Timestamp | null;
  completed_at: Timestamp | null;
  result_expires_at: Timestamp | null;
  record_expires_at: Timestamp | null;
  has_result: boolean;
  due_at: Timestamp;
  claim_token: string | null;
  incarnation: string | null;
  claim_kind: "execute" | "observe" | null;
  lease_until: Timestamp | null;
  attempts: number;
  invocation_token: string | null;
  invocation_incarnation: string | null;
  requested: boolean;
  remote_status:
    | "not-requested"
    | "pending"
    | "confirmed"
    | "unconfirmed"
    | "unsupported"
    | "unavailable";
  blocked_reason: "reauthorization-required" | "observation-authority-unavailable" | null;
  progress: Json<object> | null;
  error: Json<{ code: string; message: string }> | null;
  task_id: string | null;
  callback_correlation: string | null;
  cleanup_deadline: Timestamp | null;
  cleanup_token: string | null;
  cleanup_incarnation: string | null;
  cleanup_lease: Timestamp | null;
  cancel_issued_at: Timestamp | null;
}
export interface JobPayloadsTable {
  job_id: string;
  kind: "input" | "result" | "task";
  revision: string;
  bytes: number;
  key_id: string;
  nonce: Buffer;
  tag: Buffer;
  body: Buffer;
}
export type JobsDatabase = CoreDatabase & { jobs: JobsTable; job_payloads: JobPayloadsTable };
export type JobsDB = Kysely<JobsDatabase>;
export type JobsTransaction = Transaction<JobsDatabase>;
export type JobRow = Selectable<JobsTable>;
export type PayloadRow = Selectable<JobPayloadsTable>;
