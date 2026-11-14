import type { ColumnType, Generated, JSONColumnType } from "kysely";
import type { EncryptedEnvelope } from "../security/encryption.js";

export type Timestamp = ColumnType<Date, Date | string, Date | string>;
export type Json<T extends object | null> = JSONColumnType<T, T, T>;
export interface DeploymentsTable {
  id: string;
  kind: "cloud" | "server";
  adapter_id: string;
  config_revision: number;
  enabled: boolean;
}
export interface SitesTable {
  id: string;
  deployment_id: string;
  site_id: string;
  enabled: boolean;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}
export interface SiteChangesTable {
  id: string;
  site_id: string;
  actor_id: string;
  enabled: boolean;
  changed_at: Generated<Timestamp>;
}
export interface OwnersTable {
  id: string;
  deployment_id: string;
  site_id: string;
  subject_id: string;
}
export interface SessionsTable {
  id: string;
  owner_id: string;
  verified_at: Timestamp;
  authentication_expires_at: Timestamp;
  revoked: Generated<boolean>;
  adapter_id: string;
}
export interface AccessTokensTable {
  verifier: string;
  session_id: string;
  expires_at: Timestamp;
}
export interface AppsTable {
  id: string;
  enabled: boolean;
  config_revision: number;
  defaults: Json<Record<string, string>>;
}
export interface RegistrationsTable {
  id: string;
  enabled: boolean;
  config_revision: number;
  mode: "none" | "personal" | "operator";
  reauth_seconds: number | null;
}
export interface ConnectionsTable {
  id: string;
  provider_registration_id: string;
  owner_id: string | null;
  state: "active" | "reauthorization-required" | "renewal-uncertain" | "disconnected";
  authority_generation: number;
  credential_generation: number;
  last_connector_reauth_at: Timestamp | null;
  display: Json<{ label?: string; accountLabel?: string }>;
  account_key: string | null;
  bundle: Json<EncryptedEnvelope> | null;
  credential_expires_at: Timestamp | null;
  mutation_id: string | null;
}
export interface ConnectionAudienceTable {
  connection_id: string;
  deployment_id: string;
  site_id: string;
  subject_id: string;
}
export interface CredentialMutationsTable {
  id: string;
  connection_id: string | null;
  setup_id: string | null;
  kind: "setup" | "import" | "renewal";
  expected_authority: number;
  expected_credential: number;
  expires_at: Timestamp;
  phase:
    | "reserved"
    | "processing"
    | "waiting"
    | "dispatched"
    | "uncertain"
    | "succeeded"
    | "failed";
  may_invalidate: boolean;
  processor_token: string | null;
  incarnation: string | null;
  lease_until: Timestamp | null;
  access_session_id: string | null;
  evidence: string | null;
}
export interface CoreDatabase {
  deployments: DeploymentsTable;
  tableau_sites: SitesTable;
  site_changes: SiteChangesTable;
  owners: OwnersTable;
  sessions: SessionsTable;
  access_tokens: AccessTokensTable;
  apps: AppsTable;
  provider_registrations: RegistrationsTable;
  connections: ConnectionsTable;
  connection_audience: ConnectionAudienceTable;
  credential_mutations: CredentialMutationsTable;
}
