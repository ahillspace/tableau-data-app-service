import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  decodeControl,
  encodeControl,
  HEADER_PROFILE,
  isReserved,
  validateHeaderPairs,
} from "../public/headers.js";
import { responseOrigin } from "../transport/native.js";
import { ServiceError } from "./errors.js";

export function controls(
  request: FastifyRequest,
  proxy: boolean,
): { method: string; tunneledHead: boolean; connectionId?: string; headers: Headers } {
  let physical = 0;
  const seen = new Set<string>();
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    const name = request.raw.rawHeaders[index]?.toLowerCase() ?? "";
    physical += name.length + (request.raw.rawHeaders[index + 1]?.length ?? 0) + 4;
    if (isReserved(name)) {
      if (
        seen.has(name) ||
        ![
          "x-integration-connection",
          "x-integration-request-headers",
          ...(proxy ? ["x-integration-method"] : []),
        ].includes(name)
      )
        throw new ServiceError(400, "invalid-control", "Invalid service control");
      seen.add(name);
    }
  }
  if (physical > HEADER_PROFILE.physicalBytes)
    throw new ServiceError(431, "headers-too-large", "Request headers exceed supported transport");
  const methodControl = request.headers["x-integration-method"];
  if (
    methodControl !== undefined &&
    (request.method !== "POST" || (methodControl !== "GET" && methodControl !== "HEAD"))
  )
    throw new ServiceError(400, "invalid-control", "Invalid method carrier");
  const raw = request.headers["x-integration-request-headers"];
  let headers: Headers;
  try {
    headers = new Headers(
      raw === undefined
        ? []
        : validateHeaderPairs(decodeControl(typeof raw === "string" ? raw : "!")),
    );
  } catch {
    throw new ServiceError(400, "invalid-control", "Invalid native header control");
  }
  if (!headers.has("content-type") && request.headers["content-type"])
    headers.set("content-type", request.headers["content-type"]);
  const connection = request.headers["x-integration-connection"];
  if (
    connection !== undefined &&
    (typeof connection !== "string" || !/^[A-Za-z0-9._~-]{1,200}$/.test(connection))
  )
    throw new ServiceError(400, "invalid-control", "Invalid connection control");
  return {
    method: typeof methodControl === "string" ? methodControl : request.method,
    tunneledHead: methodControl === "HEAD",
    ...(typeof connection === "string" ? { connectionId: connection } : {}),
    headers,
  };
}
export function webBody(body: unknown): ReadableStream<Uint8Array> | undefined {
  return body instanceof Readable
    ? (Readable.toWeb(body) as ReadableStream<Uint8Array>)
    : undefined;
}
export function requestAbort(request: FastifyRequest, reply: FastifyReply): AbortSignal {
  const abort = new AbortController();
  request.raw.once("aborted", () => abort.abort(new Error("Client aborted")));
  reply.raw.once("close", () => {
    if (!reply.raw.writableFinished) abort.abort(new Error("Client disconnected"));
  });
  return abort.signal;
}
export async function sendResponse(
  reply: FastifyReply,
  response: Response,
  route: "proxy" | "capability",
  tunneledHead = false,
  stallTimeoutMs?: number,
): Promise<void> {
  const origin = responseOrigin(response);
  if (route === "proxy" && origin !== "provider")
    throw new Error("Proxy requires trusted provider response");
  const fail = async (): Promise<never> => {
    await response.body?.cancel();
    throw new ServiceError(
      origin === "provider" ? 502 : 500,
      "invalid-response",
      "Invalid response contract",
    );
  };
  if (response.status < 200 || response.status > 599) return fail();
  const pairs: [string, string][] = [];
  const excluded = new Set(
    (response.headers.get("connection") ?? "").split(",").map((name) => name.trim().toLowerCase()),
  );
  for (const [name, value] of response.headers) {
    if (
      isReserved(name) ||
      name.startsWith("access-control-") ||
      excluded.has(name) ||
      [
        "authorization",
        "set-cookie",
        "connection",
        "keep-alive",
        "transfer-encoding",
        "trailer",
        "upgrade",
        "proxy-authenticate",
      ].includes(name)
    )
      continue;
    if (origin === "service" && name === "content-length") continue;
    pairs.push([name, value]);
  }
  try {
    validateHeaderPairs(pairs);
  } catch {
    return fail();
  }
  const bodyless = tunneledHead || [204, 205, 304].includes(response.status);
  if (bodyless && response.body !== null) return fail();
  const carrier = (response.status >= 300 && response.status <= 399) || tunneledHead;
  let metadata: string | undefined;
  try {
    if (carrier) metadata = encodeControl({ version: 1, status: response.status, headers: pairs });
  } catch {
    return fail();
  }
  reply
    .header("X-Integration-Origin", origin)
    .header("cache-control", "no-store")
    .header(
      "access-control-expose-headers",
      [
        ...new Set([
          "X-Integration-Origin",
          "X-Integration-Error",
          "X-Integration-Response-Metadata",
          ...pairs.map(([name]) => name),
        ]),
      ].join(", "),
    );
  if (metadata) {
    reply.status(200).header("X-Integration-Response-Metadata", metadata);
    if (!bodyless)
      for (const [name, value] of pairs)
        if (["content-encoding", "content-length", "content-type"].includes(name))
          reply.header(name, value);
  } else {
    reply.status(response.status);
    for (const [name, value] of pairs) reply.header(name, value);
  }
  if (stallTimeoutMs !== undefined && response.body) {
    const socket = reply.raw.socket;
    let written = socket?.bytesWritten ?? 0,
      progress = performance.now();
    const timer = setInterval(
      () => {
        const now = performance.now();
        const current = socket?.bytesWritten ?? written;
        const pending =
          reply.raw.writableNeedDrain ||
          (socket?.writableNeedDrain ?? false) ||
          reply.raw.writableLength > 0;
        if (!pending || current !== written) {
          written = current;
          progress = now;
        }
        if (pending && now - progress >= stallTimeoutMs)
          reply.raw.destroy(new Error("Downstream write stalled"));
      },
      Math.max(1, Math.min(1000, Math.floor(stallTimeoutMs / 4))),
    );
    timer.unref();
    reply.raw.once("close", () => clearInterval(timer));
    reply.raw.once("finish", () => clearInterval(timer));
  }
  reply.send(
    response.body
      ? Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>)
      : undefined,
  );
}
