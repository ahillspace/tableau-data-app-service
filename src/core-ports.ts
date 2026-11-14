import type { FastifyInstance } from "fastify";
import type { CoreTransaction, Database } from "./db/database.js";
import type { SecretBox } from "./security/encryption.js";

export type VerifiedIdentity = Readonly<{
  deploymentId: string;
  siteId: string;
  subjectId: string;
  verifiedAt: Date;
  adapterId: string;
}>;
export type AccessContext = Readonly<{
  ownerId: string;
  deploymentId: string;
  siteId: string;
  subjectId: string;
  sessionId: string;
  appId: string;
  authenticationExpiresAt: Date;
}>;
export type ClaimRef = Readonly<{ token: string; incarnation: string }>;
export type OperationAuthority =
  | { source: "request"; access: AccessContext }
  | { source: "job"; jobId: string; claim: ClaimRef }
  | { source: "event-source"; sourceId: string; claim: ClaimRef }
  | { source: "remote-cancel"; jobId: string; claim: ClaimRef };
export type BundleRevision = Readonly<{
  authorityGeneration: number;
  credentialGeneration: number;
}>;
export type ConnectionUse = Readonly<{
  authority: OperationAuthority;
  connectionId: string;
  providerRegistrationId: string;
  authorityGeneration: number;
}>;
export type CredentialSnapshot = Readonly<
  BundleRevision & { credentials: unknown; runtimeContext: Readonly<Record<string, unknown>> }
>;
export type NativeRequest = {
  endpoint: string;
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
  path: string;
  query?: URLSearchParams;
  headers?: Headers;
  body?: ReadableStream<Uint8Array> | Uint8Array | string;
};
export interface ProviderContext {
  signal: AbortSignal;
  request(request: NativeRequest): Promise<Response>;
  withCredentials<T>(run: (snapshot: CredentialSnapshot) => Promise<T>): Promise<T>;
}
export interface AccessPort {
  authenticate(token: string, appId: string): Promise<AccessContext>;
  lockAuthority(
    tx: CoreTransaction,
    access: AccessContext,
    providerRegistrationId?: string,
  ): Promise<void>;
  connectionVisible(access: AccessContext, connectionId: string): Promise<boolean>;
}
export interface ProviderScope {
  context: ProviderContext;
  dispose(reason?: unknown): Promise<void>;
}
export interface ConnectionPort {
  authorizeUse(
    access: AccessContext,
    registrationId: string,
    connectionId?: string,
  ): Promise<ConnectionUse | null>;
  openScope(
    authority: OperationAuthority,
    registrationId: string,
    connectionId: string | undefined,
    signal: AbortSignal,
  ): Promise<ProviderScope>;
}
// Background owners validate their own live claim after core locks current site,
// provider, connection/audience parents; return false for stale claims, never retarget.
export interface BackgroundAuthorityPort {
  inspect(authority: Exclude<OperationAuthority, { source: "request" }>): Promise<{
    access: Omit<AccessContext, "sessionId" | "authenticationExpiresAt">;
    connectionId?: string;
    authorityGeneration?: number;
    started: boolean;
  }>;
  lockClaim(
    tx: CoreTransaction,
    authority: Exclude<OperationAuthority, { source: "request" }>,
  ): Promise<void>;
}
export interface CoreServices {
  db: Database;
  controlDb: Database;
  secrets: SecretBox;
  access: AccessPort;
  connections: ConnectionPort;
}
export interface ApiExtension {
  register(app: FastifyInstance, core: CoreServices): Promise<void>;
  health?(): Promise<"ready" | "degraded" | "disabled">;
  close?(): Promise<void>;
}
export interface MaintenanceHook {
  run(signal: AbortSignal): Promise<void>;
  close?(): Promise<void>;
}
