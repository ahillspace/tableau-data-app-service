import { Worker } from "node:worker_threads";
import { ServiceError } from "../http/errors.js";
import type { SecretBinding } from "../security/encryption.js";
import type { PayloadRow } from "./database.js";

export type PreparedPayload = Omit<PayloadRow, "job_id" | "kind">;
export type SubmissionHead = {
  handle: number;
  submissionId: string;
  capability: { id: string; version: number };
  connectionId?: string | undefined;
};
export class PayloadProcessor {
  readonly #worker: Worker;
  readonly #prepared = new WeakMap<object, () => void>();
  readonly #pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  #id = 0;
  #used = 0;
  #closed = false;
  constructor(options: { keyId: string; keys: ReadonlyMap<string, Buffer>; workingBytes: number }) {
    if (!Number.isSafeInteger(options.workingBytes) || options.workingBytes <= 0)
      throw new Error("Invalid payload memory budget");
    this.workingBytes = options.workingBytes;
    const source = import.meta.url.endsWith(".ts");
    const target = new URL(source ? "./payload-worker.ts" : "./payload-worker.js", import.meta.url);
    const entry = source
      ? new URL(
          `data:text/javascript,${encodeURIComponent(`import { tsImport } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; await tsImport(${JSON.stringify(target.href)}, import.meta.url);`)}`,
        )
      : target;
    this.#worker = new Worker(entry, {
      workerData: { keyId: options.keyId, keys: [...options.keys] },
    });
    this.#worker.on("message", (message) => {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error)
        pending.reject(new ServiceError(422, "invalid-job-payload", message.error));
      else pending.resolve(message.result);
    });
    this.#worker.on("error", () => this.#fail());
    this.#worker.on("exit", () => this.#fail());
  }
  readonly workingBytes: number;
  reserve(bytes: number): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.#used + bytes > this.workingBytes)
      throw new ServiceError(503, "payload-capacity-unavailable", "Job payload memory is busy");
    this.#used += bytes;
    let released = false;
    return () => {
      if (!released) {
        this.#used -= bytes;
        released = true;
      }
    };
  }
  #fail(): void {
    this.#closed = true;
    for (const pending of this.#pending.values())
      pending.reject(
        new ServiceError(503, "payload-unavailable", "Job payload processing is unavailable"),
      );
    this.#pending.clear();
  }
  async call<T>(op: string, data: object, transfer: ArrayBuffer[] = []): Promise<T> {
    if (this.#closed)
      throw new ServiceError(503, "payload-unavailable", "Job payload processing is unavailable");
    const id = ++this.#id;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.#worker.postMessage({ id, op, data }, transfer);
    });
  }
  async inspect(raw: Uint8Array): Promise<SubmissionHead> {
    return this.call(
      "inspect",
      { raw },
      raw.byteLength > 8192 && raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength
        ? [raw.buffer as ArrayBuffer]
        : [],
    );
  }
  async prepare(
    handle: number,
    schema: object,
    binding?: SecretBinding,
    limit?: number,
  ): Promise<{ digest: string; payload?: PreparedPayload }> {
    const result = await this.call<{ digest: string; payload?: PreparedPayload }>("prepare", {
      handle,
      schema,
      binding,
      limit,
    });
    if (result.payload) result.payload = buffers(result.payload);
    return result;
  }
  async release(handle: number): Promise<void> {
    await this.call("release", { handle });
  }
  async seal(
    value: unknown,
    schema: object,
    limit: number,
    binding: SecretBinding,
  ): Promise<PreparedPayload> {
    const measured = await this.call<{ handle: number; bytes: number }>("measure-result", {
      value,
      schema,
      limit,
    });
    let release: (() => void) | undefined;
    try {
      release = this.reserve(measured.bytes * 12);
      const result = buffers(
        await this.call<PreparedPayload>("seal-result", { handle: measured.handle, binding }),
      );
      release();
      release = undefined;
      this.#prepared.set(result, this.reserve(result.bytes * 2));
      return result;
    } finally {
      release?.();
      await this.call("release-result", { handle: measured.handle });
    }
  }
  releasePrepared(payload: PreparedPayload | undefined): void {
    if (payload) {
      this.#prepared.get(payload)?.();
      this.#prepared.delete(payload);
    }
  }
  async parseJson(raw: Uint8Array): Promise<unknown> {
    return this.call("parse-json", { raw });
  }

  async open(payload: PreparedPayload, binding: SecretBinding, raw = false): Promise<unknown> {
    return this.call(
      "open",
      { payload, binding, raw },
      payload.body.byteLength > 8192 &&
        payload.body.byteOffset === 0 &&
        payload.body.byteLength === payload.body.buffer.byteLength
        ? [payload.body.buffer as ArrayBuffer]
        : [],
    );
  }
  async close(): Promise<void> {
    this.#fail();
    await this.#worker.terminate();
  }
}
function buffers(p: PreparedPayload): PreparedPayload {
  return {
    ...p,
    nonce: Buffer.from(p.nonce.buffer, p.nonce.byteOffset, p.nonce.byteLength),
    tag: Buffer.from(p.tag.buffer, p.tag.byteOffset, p.tag.byteLength),
    body: Buffer.from(p.body.buffer, p.body.byteOffset, p.body.byteLength),
  };
}
