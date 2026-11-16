export type FieldError = { path: string; rule: string };
export type UpstreamState = "not-sent" | "may-have-been-sent";

export type ServiceErrorBody = {
  error: {
    code: string;
    message: string;
    fields?: FieldError[];
    upstream?: UpstreamState;
  };
};

/** A failure with a stable code. Messages never contain secret values. */
export class ServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: FieldError[] | undefined;
  readonly upstream: UpstreamState | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    extra: { fields?: FieldError[]; upstream?: UpstreamState; cause?: unknown } = {},
  ) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = "ServiceError";
    this.status = status;
    this.code = code;
    this.fields = extra.fields;
    this.upstream = extra.upstream;
  }

  toBody(): ServiceErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.fields ? { fields: this.fields } : {}),
        ...(this.upstream ? { upstream: this.upstream } : {}),
      },
    };
  }
}

export function invalid(fields: FieldError[], message = "The request is invalid"): ServiceError {
  return new ServiceError(400, "invalid-request", message, { fields });
}

export function notFound(code: string, message: string): ServiceError {
  return new ServiceError(404, code, message);
}
