import type { Readable } from "node:stream";
import { z } from "zod";
import type { Authentication, Ownership } from "../contracts/operator.ts";

export const API_MAJOR = 1;
export const operationName = /^[a-z][a-z0-9-]{0,62}(\.[a-z][a-z0-9-]{0,62})+$/;

export type ProviderRequest = {
  method: string;
  path: string;
  /** A concrete HTTPS base URL allowed by the definition. */
  host?: string;
  headers?: [string, string][];
  body?: Readable | Buffer | string | null;
};
export type ProviderResponse = {
  status: number;
  headers: [string, string][];
  /** Consume the body before the operation returns. */
  body: Readable;
};
export type ProviderContext = {
  signal: AbortSignal;
  upstream: { request(request: ProviderRequest): Promise<ProviderResponse> };
};

export const authenticationMethods = [
  "none",
  "static",
  "authorization_code",
  "client_credentials",
  "jwt_bearer",
  "signed_jwt_direct",
] as const satisfies readonly Authentication["method"][];

export type OperationRequirements = {
  authentication?: readonly Authentication["method"][];
  ownership?: readonly Ownership[];
  apiHosts?: readonly string[];
  connection?: boolean;
};

type OperationContract = {
  name: string;
  contractMajor: number;
  description: string;
  requirements?: OperationRequirements;
  example: z.JSONType;
  errors?: readonly string[];
};

export type ProviderOperation = OperationContract & {
  options: z.ZodType;
  input: z.ZodType;
  output: z.ZodType;
  /** Created by defineOperation, which supplies the parsed input and options. */
  run(context: ProviderContext & { input: unknown; options: unknown }): Promise<unknown>;
};

/** Declares an operation with JSON schemas and a handler typed from those schemas. Options are public configuration. */
export function defineOperation<
  Options extends z.ZodType,
  Input extends z.ZodType,
  Output extends z.ZodType,
>(
  descriptor: OperationContract & {
    options: Options;
    input: Input;
    output: Output;
    run(
      context: ProviderContext & { input: z.output<Input>; options: z.output<Options> },
    ): Promise<z.input<Output>>;
  },
): ProviderOperation {
  return {
    ...descriptor,
    run: ({ input, options, ...context }) =>
      descriptor.run({
        ...context,
        input: input as z.output<Input>,
        options: options as z.output<Options>,
      }),
  };
}

export type ProviderPackage = {
  id: string;
  version: string;
  apiMajor: number;
  operations: readonly ProviderOperation[];
};
