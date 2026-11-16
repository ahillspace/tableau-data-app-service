/**
 * Structured JSON logging. Values under secret-looking keys are replaced, and any
 * registered secret value is masked wherever it appears in a string.
 */
export type LogFields = Record<string, unknown>;
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSink = (line: string) => void;

const SECRET_KEY =
  /(secret|token|password|passwd|authorization|cookie|verifier|proof|credential|bearer|^code$|signature|sealed|key$|keys$)/i;

export class Log {
  readonly #sink: LogSink;
  readonly #secrets: Set<string>;
  readonly #base: LogFields;

  constructor(
    sink: LogSink = (line) => process.stdout.write(`${line}\n`),
    base: LogFields = {},
    secrets = new Set<string>(),
  ) {
    this.#sink = sink;
    this.#base = base;
    this.#secrets = secrets;
  }

  /** Registers a value that must never appear in output. */
  protect(value: string | undefined): void {
    if (value && value.length >= 6) this.#secrets.add(value);
  }

  child(fields: LogFields): Log {
    return new Log(this.#sink, { ...this.#base, ...fields }, this.#secrets);
  }

  debug(message: string, fields?: LogFields): void {
    if (process.env.TDAS_LOG_DEBUG === "1") this.#write("debug", message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.#write("info", message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.#write("warn", message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.#write("error", message, fields);
  }

  #write(level: LogLevel, message: string, fields?: LogFields): void {
    const record = { time: new Date().toISOString(), level, message, ...this.#base, ...fields };
    this.#sink(this.#mask(JSON.stringify(this.#redact(record, 0))));
  }

  #redact(value: unknown, depth: number): unknown {
    if (depth > 6) return "[depth]";
    if (value instanceof Error) {
      const code = (value as { code?: unknown }).code;
      return {
        name: value.name,
        message: value.message,
        ...(typeof code === "string" ? { code } : {}),
        ...(value.cause !== undefined ? { cause: this.#redact(value.cause, depth + 1) } : {}),
      };
    }
    if (Array.isArray(value)) return value.map((item) => this.#redact(item, depth + 1));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] =
          SECRET_KEY.test(key) &&
          item !== null &&
          item !== undefined &&
          typeof item !== "boolean" &&
          typeof item !== "number"
            ? "[redacted]"
            : this.#redact(item, depth + 1);
      }
      return out;
    }
    return value;
  }

  #mask(line: string): string {
    let out = line;
    for (const secret of this.#secrets) {
      for (const form of [
        secret,
        JSON.stringify(secret).slice(1, -1),
        encodeURIComponent(secret),
      ]) {
        if (form && out.includes(form)) out = out.split(form).join("[redacted]");
      }
    }
    return out;
  }
}
