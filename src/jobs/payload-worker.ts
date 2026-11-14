import { createHash } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import canonicalize from "canonicalize";
import { type SecretBinding, SecretBox } from "../security/encryption.js";

const box = new SecretBox(workerData.keyId, new Map(workerData.keys));
const ajv = new Ajv2020({ useDefaults: true, strict: false, allErrors: false });
addFormats.default(ajv);
const inputs = new Map<number, Record<string, unknown>>();
const preparedTexts = new Map<number, string>();
let next = 0;
function json(value: unknown): string {
  const result = canonicalize(value);
  if (result === undefined) throw new Error("Expected JSON value");
  return result;
}
function validate(value: unknown, schema: object): unknown {
  const run = ajv.compile(schema);
  try {
    if (!run(value)) throw new Error("Payload failed its declared schema");
    return value;
  } finally {
    ajv.removeSchema(schema);
  }
}
function seal(value: unknown, schema: object, limit: number, binding: SecretBinding) {
  validate(value, schema);
  const text = json(value);
  const bytes = Buffer.byteLength(text);
  if (bytes > limit) throw new Error("Payload exceeds its byte limit");
  return sealText(text, binding);
}
function sealText(text: string, binding: SecretBinding) {
  const bytes = Buffer.byteLength(text);
  const plaintext = Buffer.from(text);
  try {
    const envelope = box.seal(plaintext, binding);
    return {
      bytes,
      key_id: envelope.keyId,
      nonce: Buffer.from(envelope.nonce, "base64url"),
      tag: Buffer.from(envelope.tag, "base64url"),
      body: Buffer.from(envelope.ciphertext, "base64url"),
      revision: binding.revision,
    };
  } finally {
    plaintext.fill(0);
  }
}
parentPort!.on("message", (message) => {
  try {
    const { id, op, data } = message;
    let result: unknown;
    if (op === "inspect") {
      const parsed = JSON.parse(
        Buffer.from(data.raw.buffer, data.raw.byteOffset, data.raw.byteLength).toString(),
      ) as Record<string, unknown>;
      if (
        !parsed ||
        Array.isArray(parsed) ||
        typeof parsed !== "object" ||
        !Object.hasOwn(parsed, "input") ||
        Object.keys(parsed).some(
          (key) => !["submissionId", "capability", "connectionId", "input"].includes(key),
        )
      )
        throw new Error("Invalid Job submission");
      const handle = ++next;
      inputs.set(handle, parsed);
      result = {
        handle,
        submissionId: parsed.submissionId,
        capability: parsed.capability,
        ...(parsed.connectionId === undefined ? {} : { connectionId: parsed.connectionId }),
      };
    } else if (op === "prepare") {
      const parsed = inputs.get(data.handle);
      if (!parsed) throw new Error("Submission preparation expired");
      validate(parsed.input, data.schema);
      // Explicit automatic selection is distinct from an explicitly selected connection.
      const command = json([
        1,
        parsed.capability,
        parsed.connectionId === undefined
          ? { automatic: true }
          : { connectionId: parsed.connectionId },
        parsed.input,
      ]);
      result = {
        digest: createHash("sha256").update(command).digest("hex"),
        ...(data.binding
          ? { payload: seal(parsed.input, data.schema, data.limit, data.binding) }
          : {}),
      };
    } else if (op === "release") {
      inputs.delete(data.handle);
      result = null;
    } else if (op === "measure-result") {
      validate(data.value, data.schema);
      const text = json(data.value);
      const bytes = Buffer.byteLength(text);
      if (bytes > data.limit) throw new Error("Payload exceeds its byte limit");
      const handle = ++next;
      preparedTexts.set(handle, text);
      result = { handle, bytes };
    } else if (op === "seal-result") {
      const text = preparedTexts.get(data.handle);
      if (text === undefined) throw new Error("Missing prepared result");
      preparedTexts.delete(data.handle);
      result = sealText(text, data.binding);
    } else if (op === "release-result") {
      preparedTexts.delete(data.handle);
      result = null;
    } else if (op === "parse-json") {
      result = JSON.parse(Buffer.from(data.raw).toString());
    } else if (op === "open") {
      const p = data.payload;
      const plain = box.open(
        {
          v: 1,
          keyId: p.key_id,
          nonce: Buffer.from(p.nonce).toString("base64url"),
          tag: Buffer.from(p.tag).toString("base64url"),
          ciphertext: Buffer.from(p.body).toString("base64url"),
        },
        data.binding,
      );
      try {
        if (plain.length !== p.bytes) throw new Error("Payload length mismatch");
        result = data.raw ? Uint8Array.from(plain) : JSON.parse(plain.toString());
      } finally {
        plain.fill(0);
      }
    } else throw new Error("Unknown payload operation");
    const body = (result as { body?: Uint8Array } | null)?.body;
    const transfer =
      body &&
      body.byteLength > 8192 &&
      body.byteOffset === 0 &&
      body.byteLength === body.buffer.byteLength
        ? [body.buffer]
        : result instanceof Uint8Array && result.byteLength > 8192
          ? [result.buffer]
          : [];
    parentPort!.postMessage({ id, result }, transfer as ArrayBuffer[]);
  } catch {
    // Never send raw validation exceptions or sensitive values across the error/log boundary.
    parentPort!.postMessage({ id: message.id, error: "Invalid or corrupt Job payload" });
  }
});
