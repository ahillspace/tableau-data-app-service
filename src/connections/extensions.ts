import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  API_MAJOR,
  authenticationMethods,
  operationName,
  type ProviderOperation,
  type ProviderPackage,
} from "../extensions/provider.ts";
import type { FieldError } from "../platform/errors.ts";
import { fieldErrors } from "../platform/validation.ts";
import { matchesApiHost, normalizeApiHost } from "./hosts.ts";
import type {
  CredentialLease,
  Definition,
  OperationBinding,
  OperationBindings,
  ProtocolFetch,
} from "./types.ts";
export type Account = { id: string; name: string | null };
export type ExtensionContext = { fetch: ProtocolFetch; signal: AbortSignal };
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

const packageId = /^[a-z][a-z0-9-]{0,62}$/;
const packageVersion =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const requirementsSchema = z.strictObject({
  authentication: z.array(z.enum(authenticationMethods)).min(1).optional(),
  ownership: z
    .array(z.enum(["personal", "shared"]))
    .min(1)
    .optional(),
  apiHosts: z
    .array(z.string().refine((host) => !!normalizeApiHost(host, false)))
    .min(1)
    .optional(),
  connection: z.boolean().optional(),
});

const jsonOptions = z.record(z.string(), z.json());

type InstalledOperation = {
  operation: ProviderOperation;
  contract: {
    contractMajor: number;
    description: string;
    input: { [key: string]: unknown };
    output: { [key: string]: unknown };
    options: { [key: string]: unknown };
    example: z.JSONType;
    errors: readonly string[];
  };
};

function supportsDefinition(operation: ProviderOperation, definition: Definition): boolean {
  const requirements = operation.requirements;
  return (
    (!requirements?.connection || definition.authentication.method !== "none") &&
    (!requirements?.authentication ||
      requirements.authentication.includes(definition.authentication.method)) &&
    (!requirements?.ownership || requirements.ownership.includes(definition.ownership)) &&
    (!requirements?.apiHosts ||
      requirements.apiHosts.every((host) =>
        definition.apiHosts.some((base) => matchesApiHost(base, host)),
      ))
  );
}

function installOperation(operation: ProviderOperation): InstalledOperation {
  try {
    const {
      contractMajor,
      description,
      errors = [],
      example,
      input,
      options,
      output,
      requirements,
      run,
    } = operation;
    if (
      !Number.isSafeInteger(contractMajor) ||
      contractMajor < 1 ||
      typeof description !== "string" ||
      !description.trim() ||
      typeof run !== "function" ||
      (requirements !== undefined && !requirementsSchema.safeParse(requirements).success) ||
      !z.array(z.string().min(1)).safeParse(errors).success ||
      !z.json().safeParse(example).success ||
      !input.safeParse(example).success
    )
      throw new Error();
    const optionsContract = z.toJSONSchema(options, { io: "input" });
    if (optionsContract.type !== "object" || z.toJSONSchema(options).type !== "object")
      throw new Error();
    return {
      operation,
      contract: {
        contractMajor,
        description,
        options: optionsContract,
        input: z.toJSONSchema(input, { io: "input" }),
        output: z.toJSONSchema(output),
        example,
        errors,
      },
    };
  } catch {
    throw new Error(`Invalid provider operation descriptor: ${operation.name}`);
  }
}

/** Trusted provider operations and Job handlers are explicitly installed at deployment. */
export class Extensions {
  readonly #handlers = new Map<string, JobHandlerDefinition>();
  readonly #operations = new Map<string, InstalledOperation>();
  readonly #packages = new Map<string, string>();
  constructor(
    options: {
      jobHandlers?: readonly JobHandlerDefinition[];
      providerPackages?: readonly ProviderPackage[];
    } = {},
  ) {
    for (const handler of options.jobHandlers ?? []) {
      if (!packageId.test(handler.name) || this.#handlers.has(handler.name))
        throw new Error("Invalid or duplicate Job handler name");
      this.#handlers.set(handler.name, handler);
    }
    for (const provider of options.providerPackages ?? []) {
      if (!provider || typeof provider.id !== "string" || !packageId.test(provider.id))
        throw new Error("Invalid provider package ID");
      if (this.#packages.has(provider.id))
        throw new Error(`Duplicate provider package: ${provider.id}`);
      if (provider.apiMajor !== API_MAJOR)
        throw new Error(`Incompatible provider API major: ${provider.id}`);
      if (
        typeof provider.version !== "string" ||
        !packageVersion.test(provider.version) ||
        !Array.isArray(provider.operations)
      )
        throw new Error(`Invalid provider package descriptor: ${provider.id}`);
      this.#packages.set(provider.id, provider.version);
      for (const operation of provider.operations) {
        if (
          !operation ||
          typeof operation.name !== "string" ||
          !operationName.test(operation.name) ||
          !operation.name.startsWith(`${provider.id}.`) ||
          this.#operations.has(operation.name)
        )
          throw new Error(
            `Invalid or duplicate operation name in provider package: ${provider.id}`,
          );
        this.#operations.set(operation.name, installOperation(operation));
      }
    }
  }
  handler(name: string): { handler: JobHandlerDefinition } | undefined {
    const handler = this.#handlers.get(name);
    return handler ? { handler } : undefined;
  }
  resolve(name: string, binding: OperationBinding, definition: Definition) {
    const installed = this.#operations.get(name);
    if (!installed) return { ready: false, reason: "operation-missing" } as const;
    if (installed.operation.contractMajor !== binding.contractMajor)
      return { ready: false, reason: "contract-major-mismatch" } as const;
    if (!supportsDefinition(installed.operation, definition))
      return { ready: false, installed, reason: "definition-requirements" } as const;
    const options = installed.operation.options.safeParse(binding.options);
    if (!options.success)
      return { ready: false, installed, reason: "operation-options-invalid" } as const;
    return { ready: true as const, installed, options: options.data };
  }
  packages(): { id: string; version: string }[] {
    return [...this.#packages].map(([id, version]) => ({ id, version }));
  }
  validateBindings(definition: Definition, previous: OperationBindings = {}) {
    const operations = { ...definition.operations };
    const errors: FieldError[] = [];
    for (const [name, binding] of Object.entries(operations)) {
      const before = previous[name];
      // Removals or redeployments must not invalidate unrelated edits or a straight detachment.
      if (
        before &&
        before.contractMajor === binding.contractMajor &&
        isDeepStrictEqual(before.options, binding.options) &&
        (before.enabled === binding.enabled || !binding.enabled)
      )
        continue;
      const path = `operations.${name}`;
      const installed = this.#operations.get(name);
      if (!installed || installed.operation.contractMajor !== binding.contractMajor) {
        errors.push({ path: `${path}.contractMajor`, rule: "installed-operation-contract" });
        continue;
      }
      const { operation } = installed;
      if (!supportsDefinition(operation, definition))
        errors.push({ path, rule: "operation-definition-requirements" });
      const parsed = operation.options.safeParse(binding.options);
      if (!parsed.success) {
        errors.push(...fieldErrors(parsed.error, `${path}.options`));
        continue;
      }
      const options = jsonOptions.safeParse(parsed.data);
      if (!options.success) errors.push(...fieldErrors(options.error, `${path}.options`));
      else operations[name] = { ...binding, options: options.data };
    }
    return { errors, operations };
  }
}
