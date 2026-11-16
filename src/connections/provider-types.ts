import type { Principal } from "../identity/types.ts";
import type { FieldError } from "../platform/errors.ts";
import type {
  ConnectionDefinition,
  CredentialLease,
  ProtocolFetch,
  StoredCredential,
} from "./types.ts";

/**
 * A provider type is code that knows how to obtain, refresh and place one kind of credential.
 * The built-in types are `oauth2`, `static` and `none`; a preset is a provider type with
 * provider-specific defaults and behavior, and may register capabilities, Job handlers and an event source.
 */
export interface ProviderType {
  readonly name: string;
  /**
   * Whether the type connects through the OAuth authorization code flow.
   * `optional` types accept a definition without a client ID, which then takes static credentials only.
   */
  readonly oauth: "required" | "optional" | "none";
  /** Whether a token or API key may be stored as given. */
  readonly staticCredential: boolean;
  /** Whether requests carry no credential at all. */
  readonly credentialless: boolean;
  /** Preset fields the operator may leave out; operator-given values win. */
  defaults?(input: Record<string, unknown>): Record<string, unknown>;
  /** Extra rules beyond the generic ones; every failing field is returned. */
  validate?(definition: ConnectionDefinition): FieldError[];
  /** Parameters added to the authorization request; replaces the generic `scope` parameter. */
  authorizationParameters?(definition: ConnectionDefinition): Record<string, string>;
  /** Reads a token endpoint response; the generic reader handles RFC 6749 responses. */
  readTokenResponse?(
    response: TokenResponse,
    context: { definition: ConnectionDefinition; refresh: boolean; now: Date },
  ): TokenReading;
  /** Names the provider account for display. Never blocks storing a credential. */
  describeAccount?(lease: CredentialLease, context: PresetContext): Promise<Account | null>;
  /** Asks the provider to revoke the grant after the service has deleted it. */
  revoke?(lease: CredentialLease, context: PresetContext): Promise<void>;
  readonly capabilities?: readonly Capability[];
  readonly jobHandlers?: readonly JobHandlerDefinition[];
  readonly eventSource?: EventSource;
}

export type TokenResponse = { status: number; body: unknown };

/** The provider account a connection belongs to, for display. */
export type Account = { id: string; name: string | null };

/**
 * The outcome of reading a token endpoint response.
 * `definitive` says the provider clearly refused, so nothing changed on its side;
 * `rejectsGrant` says the grant itself is no longer valid and the user must authorize again.
 */
export type TokenReading =
  | { kind: "ok"; credential: StoredCredential; account: Account | null; scopes: string[] }
  | { kind: "error"; error: string; definitive: boolean; rejectsGrant: boolean };

/** What preset code may use to call its provider: protocol fetches with the definition's destination rules. */
export type PresetContext = {
  fetch: ProtocolFetch;
  signal: AbortSignal;
};

/** A named preset operation that runs inside an API request with the same checkout and transport as native requests. */
export type Capability = {
  readonly name: string;
  run(
    context: PresetContext & { lease: CredentialLease; principal: Principal; input: unknown },
  ): Promise<unknown>;
};

/**
 * A Job handler as a preset registers it. A Job names its handler and a definition of the
 * handler's provider type; the handler runs with that definition's connection for the Job's owner.
 * Handler names are unique across the installation.
 */
export type JobHandlerDefinition = {
  readonly name: string;
  /** Whether an interrupted run may start again; the provider may have acted on the first run. */
  readonly retrySafe: boolean;
  /** Settled failures are retried only when the handler declares a retry count. */
  readonly retries?: { attempts: number; backoffSeconds: number };
  readonly limits?: { inputBytes?: number; resultBytes?: number; runtimeSeconds?: number };
  validateInput?(input: unknown): FieldError[];
  run(context: JobRunContext): Promise<JobStepResult>;
  /** Asks the external system to stop a waiting Job's task. Best effort; failure leaves remote effects unknown. */
  cancel?(context: JobCancelContext): Promise<void>;
};

export type JobCancelContext = {
  externalTaskId: string;
  checkout(): Promise<CredentialLease>;
  fetch: ProtocolFetch;
  signal: AbortSignal;
};

export type JobRunContext = {
  input: unknown;
  /** The callback body when an external task resumed the Job, otherwise undefined. */
  resume: unknown;
  attempt: number;
  checkout(): Promise<CredentialLease>;
  fetch: ProtocolFetch;
  progress(value: unknown): Promise<void>;
  /**
   * Issues this run's callback: a URL the external task calls when it is done, and the verifier the
   * handler returns in its wait. A callback that arrives before the wait is recorded still resumes the Job.
   */
  callback(): Promise<{ url: string; verifier: string }>;
  signal: AbortSignal;
};

export type JobStepResult =
  | { kind: "succeeded"; result: unknown }
  | { kind: "failed"; code: string; message: string }
  | {
      kind: "wait";
      externalTaskId: string;
      /** Optional time to run again and check status without a callback. */
      checkAt?: Date;
    }
  | { kind: "cancelled"; remoteEffectsUnknown: boolean };

/** Receives provider deliveries for a definition and turns each into events. */
export type EventSource = {
  /** Whether the definition must have a sealed signing secret before deliveries are accepted. */
  readonly signingSecret: "required" | "optional";
  ingest(
    delivery: EventDelivery,
    context: { definition: ConnectionDefinition; signingSecret: string | undefined },
  ): IngestOutcome;
};

export type EventDelivery = {
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  now: Date;
};

export type IncomingEvent = { id: string; type: string; account: string; payload: unknown };

export type IngestOutcome = {
  /** What the provider receives back. */
  response: { status: number; contentType?: string; body?: string };
  events: IncomingEvent[];
};

/** The generic OAuth 2.0 token response reader (RFC 6749 section 5). */
export function readStandardTokenResponse(response: TokenResponse, now: Date): TokenReading {
  const body = response.body;
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (response.status === 200 && typeof record.access_token === "string" && record.access_token) {
    const expiresIn = Number(record.expires_in);
    return {
      kind: "ok",
      credential: {
        accessToken: record.access_token,
        ...(typeof record.refresh_token === "string" && record.refresh_token
          ? { refreshToken: record.refresh_token }
          : {}),
        ...(Number.isFinite(expiresIn) && expiresIn > 0
          ? { expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString() }
          : {}),
      },
      account: null,
      scopes: typeof record.scope === "string" ? record.scope.split(/[\s,]+/).filter(Boolean) : [],
    };
  }
  const named = typeof record.error === "string" && /^[\x21-\x7e]{1,100}$/.test(record.error);
  const error = named ? (record.error as string) : `http-${response.status}`;
  const definitive = named && response.status >= 400 && response.status < 500;
  return {
    kind: "error",
    error,
    definitive,
    rejectsGrant: definitive && error === "invalid_grant",
  };
}

export const OAUTH2: ProviderType = {
  name: "oauth2",
  oauth: "required",
  staticCredential: false,
  credentialless: false,
};
export const STATIC: ProviderType = {
  name: "static",
  oauth: "none",
  staticCredential: true,
  credentialless: false,
};
export const NONE: ProviderType = {
  name: "none",
  oauth: "none",
  staticCredential: false,
  credentialless: true,
};

/** Every provider type the installation knows, keyed by the definition `type` value. */
export class ProviderTypes {
  readonly #types = new Map<string, ProviderType>();
  readonly #handlers = new Map<string, { handler: JobHandlerDefinition; type: string }>();

  constructor(presets: readonly ProviderType[]) {
    for (const type of [OAUTH2, STATIC, NONE, ...presets]) {
      if (this.#types.has(type.name))
        throw new Error(`Provider type ${type.name} is registered twice`);
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(type.name))
        throw new Error(`Provider type name ${type.name} is not a slug`);
      for (const handler of type.jobHandlers ?? []) {
        if (!/^[a-z][a-z0-9-]{0,62}$/.test(handler.name))
          throw new Error(`Job handler name ${handler.name} is not a slug`);
        if (this.#handlers.has(handler.name))
          throw new Error(`Job handler ${handler.name} is registered twice`);
        this.#handlers.set(handler.name, { handler, type: type.name });
      }
      this.#types.set(type.name, type);
    }
  }

  get(name: string): ProviderType | undefined {
    return this.#types.get(name);
  }

  names(): string[] {
    return [...this.#types.keys()];
  }

  /** A Job handler and the provider type that registered it. */
  handler(name: string): { handler: JobHandlerDefinition; type: string } | undefined {
    return this.#handlers.get(name);
  }
}
