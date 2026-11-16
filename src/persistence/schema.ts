import type { ColumnType, Generated } from "kysely";

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
type Json<T = unknown> = ColumnType<T, string, string>;

export type Attribution = { siteContentUrl?: string; workbook?: string; view?: string };

export interface Database {
  installation_revision: {
    id: number;
    revision: ColumnType<string, string | number, string | number>;
  };
  deployments: {
    id: string;
    kind: string;
    pod_origin: string;
    created_at: CreatedAt;
  };
  trusted_sites: {
    id: Generated<string>;
    deployment_id: string;
    content_url: string;
    site_id: string | null;
    enabled: boolean;
    created_at: CreatedAt;
    bound_at: Timestamp | null;
  };
  operators: {
    id: Generated<string>;
    deployment_id: string;
    site_content_url: string;
    username: string;
    site_id: string | null;
    user_id: string | null;
    created_at: CreatedAt;
    bound_at: Timestamp | null;
  };
  identities: {
    id: Generated<string>;
    deployment_id: string;
    site_id: string;
    user_id: string;
    site_content_url: string;
    user_name: string;
    last_verified_at: Timestamp;
    created_at: CreatedAt;
  };
  sign_in_transactions: {
    id: Generated<string>;
    state_hash: string;
    /** Hash of the cookie that binds the transaction to the browser that started it. */
    browser_hash: string;
    deployment_id: string;
    pkce_verifier: string;
    nonce: string;
    return_to: string;
    expires_at: Timestamp;
  };
  sign_in_sessions: {
    id: Generated<string>;
    cookie_hash: string;
    identity_id: string;
    verified_at: Timestamp;
    expires_at: Timestamp;
    created_at: CreatedAt;
  };
  restore_tokens: {
    id: Generated<string>;
    token_hash: string;
    sign_in_session_id: string;
    expires_at: Timestamp;
    created_at: CreatedAt;
  };
  app_sign_ins: {
    id: Generated<string>;
    proof_hash: string;
    app_id: string;
    attribution: Json<Attribution>;
    code_hash: string | null;
    sign_in_session_id: string | null;
    expires_at: Timestamp;
    redeemed_at: Timestamp | null;
    created_at: CreatedAt;
  };
  app_sessions: {
    id: Generated<string>;
    bearer_hash: string;
    kind: "app" | "operator";
    identity_id: string;
    sign_in_session_id: string;
    app_id: string | null;
    attribution: Json<Attribution>;
    location: Json<{ verified: boolean }>;
    expires_at: Timestamp;
    created_at: CreatedAt;
  };
  operator_sign_ins: {
    id: Generated<string>;
    mode: "loopback" | "popup";
    redirect_uri: string | null;
    code_challenge: string;
    /** The CLI's own state value, echoed to its loopback address. */
    client_state: string | null;
    /** Hash of the consent form token, so only the rendered consent page can approve. */
    consent_hash: string | null;
    code_hash: string | null;
    sign_in_session_id: string | null;
    expires_at: Timestamp;
    redeemed_at: Timestamp | null;
    created_at: CreatedAt;
  };
  apps: {
    app_id: string;
    first_seen_at: Timestamp;
    last_seen_at: Timestamp;
    session_count: ColumnType<string, number | string, number | string>;
    site_ids: ColumnType<string[], string[], string[]>;
    workbooks: ColumnType<string[], string[], string[]>;
  };
  definitions: {
    id: string;
    display_name: string;
    type: string;
    ownership: "shared" | "personal";
    api_hosts: Json<string[]>;
    authorization_endpoint: string | null;
    token_endpoint: string | null;
    client_id: string | null;
    token_authentication: "basic" | "post" | null;
    scopes: Json<string[]>;
    preset_options: Json<Record<string, unknown>>;
    credential_placement: Json<Placement>;
    audience: Json<string[]>;
    reauthorization_interval: number | null;
    private_hosts: boolean;
    enabled: boolean;
    retired: Generated<boolean>;
    generation: Generated<number>;
    created_at: CreatedAt;
    updated_at: Timestamp;
    retired_at: Timestamp | null;
  };
  definition_secrets: {
    definition_id: string;
    field: "clientSecret" | "signingSecret";
    sealed: Json<SealedJson>;
    set_at: Timestamp;
  };
  secret_links: {
    id: Generated<string>;
    token_hash: string;
    definition_id: string;
    /** The definition generation the link was created for; a redefinition makes the link unusable. */
    generation: number;
    field: "clientSecret" | "signingSecret" | "credential";
    created_by: string;
    expires_at: Timestamp;
    used_at: Timestamp | null;
    created_at: CreatedAt;
  };
  connections: {
    id: Generated<string>;
    definition_id: string;
    generation: number;
    owner_identity_id: string | null;
    status: "connected" | "needs-authorization" | "disconnected";
    sealed: Json<SealedJson> | null;
    account: string | null;
    account_name: string | null;
    scopes: Json<string[]>;
    authorized_at: Timestamp;
    credential_expires_at: Timestamp | null;
    disconnected_at: Timestamp | null;
    disconnect_reason: string | null;
    created_at: CreatedAt;
    updated_at: Timestamp;
  };
  connect_transactions: {
    id: Generated<string>;
    state_hash: string | null;
    definition_id: string;
    generation: number;
    identity_id: string;
    shared: boolean;
    pkce_verifier: string | null;
    started: Generated<boolean>;
    status: Generated<"pending" | "connected" | "failed">;
    failure: string | null;
    expires_at: Timestamp;
    created_at: CreatedAt;
  };
  jobs: {
    id: Generated<string>;
    handler: string;
    definition_id: string | null;
    owner_identity_id: string;
    app_id: string;
    submission_key: string;
    input_hash: string;
    input: Json;
    state: JobStateColumn;
    progress: Json | null;
    attempt: number;
    lease_owner: string | null;
    lease_expires_at: Timestamp | null;
    run_after: Timestamp;
    deadline_at: Timestamp | null;
    external_task_id: string | null;
    callback_verifier_hash: string | null;
    /** A callback body waiting for the Job's next attempt. */
    resume: Json | null;
    /** The callback body the current attempt runs with, kept until that attempt commits a state. */
    resuming: Json | null;
    cancel_requested: boolean;
    remote_effects_unknown: boolean;
    /** An earlier attempt ended in a way the provider may have acted on; kept for the final state. */
    earlier_effects_unknown: Generated<boolean>;
    error: Json | null;
    created_at: CreatedAt;
    started_at: Timestamp | null;
    finished_at: Timestamp | null;
    result_expires_at: Timestamp | null;
    record_expires_at: Timestamp | null;
  };
  job_results: { job_id: string; result: Json; size: number; expires_at: Timestamp };
  audit: {
    id: Generated<string>;
    at: CreatedAt;
    actor: string;
    action: string;
    target: string | null;
    detail: Json<Record<string, unknown>>;
  };
}

export type JobStateColumn =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";
export type SealedJson = { keyId: string; nonce: string; ciphertext: string; tag: string };
export type Placement =
  | { kind: "bearer" }
  | { kind: "header"; name: string; prefix?: string }
  | { kind: "query"; name: string };
