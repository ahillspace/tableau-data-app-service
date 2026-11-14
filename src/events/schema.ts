import type { Kysely } from "kysely";
import type { CoreDatabase, Json, Timestamp } from "../db/schema.js";
import type { EncryptedEnvelope } from "../security/encryption.js";

export interface EventSourcesTable {
  id: string;
  provider_registration_id: string;
  setup_kind: "manual" | "app" | "service";
  owner_id: string | null;
  setup_owner_id: string;
  setup_app_id: string;
  connection_id: string | null;
  authority_generation: number | null;
  account_key: string;
  revision: number;
  state: "configured" | "active" | "attention-required" | "retired";
  verified: boolean;
  private_context: Json<EncryptedEnvelope>;
  provider_expires_at: Timestamp | null;
  renew_after: Timestamp | null;
  claim_token: string | null;
  claim_incarnation: string | null;
  lease_until: Timestamp | null;
  operation: "create" | "renew" | "retire" | null;
  phase: "claimed" | "may-have-dispatched" | "uncertain" | null;
}
export interface EventAudienceTable {
  source_id: string;
  deployment_id: string;
  site_id: string;
  subject_id: string;
}
export interface EventsDatabase extends CoreDatabase {
  event_sources: EventSourcesTable;
  event_source_audience: EventAudienceTable;
}
export type EventsDb = Kysely<EventsDatabase>;
