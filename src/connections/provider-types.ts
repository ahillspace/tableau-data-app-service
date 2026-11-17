import type { Principal } from "../identity/types.ts";
import type { FieldError } from "../platform/errors.ts";
import type { CredentialLease, ProtocolFetch } from "./types.ts";
export type Account = { id: string; name: string | null };
export type PresetContext = { fetch: ProtocolFetch; signal: AbortSignal };
export type Capability = {
  readonly name: string;
  run(
    context: PresetContext & { lease: CredentialLease; principal: Principal; input: unknown },
  ): Promise<unknown>;
};
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

/** Trusted code extensions are independent of credential acquisition and provider catalogs. */
export class Extensions {
  readonly #handlers = new Map<string, JobHandlerDefinition>();
  readonly #capabilities = new Map<string, Capability>();
  constructor(
    options: {
      jobHandlers?: readonly JobHandlerDefinition[];
      capabilities?: readonly Capability[];
    } = {},
  ) {
    for (const handler of options.jobHandlers ?? []) {
      if (!/^[a-z][a-z0-9-]{0,62}$/.test(handler.name) || this.#handlers.has(handler.name))
        throw new Error("Invalid or duplicate Job handler name");
      this.#handlers.set(handler.name, handler);
    }
    for (const capability of options.capabilities ?? []) {
      if (
        !/^[a-z][a-z0-9-]{0,62}$/.test(capability.name) ||
        this.#capabilities.has(capability.name)
      )
        throw new Error("Invalid or duplicate capability name");
      this.#capabilities.set(capability.name, capability);
    }
  }
  handler(name: string): { handler: JobHandlerDefinition } | undefined {
    const handler = this.#handlers.get(name);
    return handler ? { handler } : undefined;
  }
  capability(name: string): Capability | undefined {
    return this.#capabilities.get(name);
  }
}
