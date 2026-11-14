import type { Selectable } from "kysely";
import type { ProviderContext } from "../core-ports.js";
import type { EventSourcesTable } from "./schema.js";

export type Source = Selectable<EventSourcesTable>;
export type VerifiedEvent = {
  id: string;
  type: string;
  payload: Uint8Array;
  mediaType: string;
  /** Signature/replay validity and provider event validity are distinct from subscription health. */
  validUntil: Date;
};
export type IngressReply = { status: number; body?: string; contentType?: string };
export type IngressVerification =
  | { challenge: IngressReply }
  | { event: VerifiedEvent; acknowledgement: IngressReply };
export type SourcePublication = {
  accountKey: string;
  privateContext: Record<string, unknown>;
  expiresAt?: Date;
  renewAfter?: Date;
};
export type SourceHook = (context: {
  source: Source;
  privateContext: Record<string, unknown>;
  provider: ProviderContext;
  signal: AbortSignal;
  /** Must commit before any externally mutating dispatch. */
  markMayHaveDispatched(): Promise<void>;
}) => Promise<SourcePublication>;
export interface EventProvider {
  /** Exact bounded raw request; verification must reject unsupported signatures/challenges. */
  verify(input: {
    source: Source;
    privateContext: Record<string, unknown>;
    headers: Headers;
    raw: Uint8Array;
    now: Date;
  }): Promise<IngressVerification>;
  /** Rechecks event-specific validity; never infer a cutoff from renewal health. */
  eventValid(source: Source, event: { ingressAt: Date; validUntil: Date }, now: Date): boolean;
  forwardingUnavailable: IngressReply;
  /** Trusted server-side setup verification, including account routing, before publishing an association. */
  verifyAssociation(
    input: Record<string, unknown>,
    context: ProviderContext,
  ): Promise<SourcePublication>;
  hooks?: Partial<Record<"create" | "renew" | "retire", SourceHook>>;
}
