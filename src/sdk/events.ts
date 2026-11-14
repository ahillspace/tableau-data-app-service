import { type PublicLiveData, publicLiveDataSchema } from "../public/schemas.js";
import { ClientHttp, ProtocolError, ServiceError } from "./http.js";

export type LiveNotification =
  | {
      kind: "provider";
      id: string;
      provider: string;
      connectionId?: string;
      type: string;
      data: unknown | Uint8Array;
    }
  | Extract<PublicLiveData, { kind: "job-hint" | "resync-required" }>;

/** Incremental bounded SSE parser. Notification IDs are never sent back as replay cursors. */
export async function consumeEvents(
  response: Response,
  payloadBytes: number,
  receive: (event: LiveNotification) => void | Promise<void>,
): Promise<void> {
  if (
    !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new ProtocolError("Expected an SSE event stream");
  }
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 1)
    throw new TypeError("Invalid deployed event payload limit");
  const encodedLimit = Math.ceil((4 * payloadBytes) / 3),
    frameLimit = encodedLimit + 4096;
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let line = "",
    name = "",
    data = "",
    frameBytes = 0,
    carriage = false;
  const dispatch = async () => {
    if (data) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        throw new ProtocolError("Invalid SSE JSON");
      }
      if (
        parsed &&
        typeof parsed === "object" &&
        "payload" in parsed &&
        typeof parsed.payload === "string" &&
        parsed.payload.length > encodedLimit
      )
        throw new ProtocolError("Oversized live payload");
      const result = publicLiveDataSchema.safeParse(parsed);
      if (!result.success || name !== result.data.kind)
        throw new ProtocolError("Invalid SSE event discriminator");
      const event = result.data;
      if (event.kind === "provider") {
        let bytes: Uint8Array;
        try {
          bytes = Uint8Array.from(
            atob(event.payload.replaceAll("-", "+").replaceAll("_", "/")),
            (char) => char.charCodeAt(0),
          );
          if (bytes.byteLength > payloadBytes) throw new Error("Oversized payload");
          let canonical = "";
          for (const byte of bytes) canonical += String.fromCharCode(byte);
          if (
            btoa(canonical).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") !==
            event.payload
          )
            throw new Error("Noncanonical encoding");
        } catch {
          throw new ProtocolError("Invalid live payload encoding");
        }
        let native: unknown = bytes;
        if (
          /^(application\/json)(?:\s*;|$)/i.test(event.payloadMediaType) ||
          /^[^;]+\+json(?:\s*;|$)/i.test(event.payloadMediaType)
        ) {
          try {
            native = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          } catch {
            throw new ProtocolError("Invalid provider JSON payload");
          }
        }
        await receive({
          kind: "provider",
          id: event.id,
          provider: event.provider,
          ...(event.connectionId ? { connectionId: event.connectionId } : {}),
          type: event.type,
          data: native,
        });
      } else await receive(event);
    }
    name = "";
    data = "";
    frameBytes = 0;
  };
  const finishLine = async () => {
    if (line === "") await dispatch();
    else if (!line.startsWith(":")) {
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") name = value;
      if (field === "data") data += `${data ? "\n" : ""}${value}`;
    }
    line = "";
  };
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const text = decoder.decode(next.value, { stream: true });
      for (const char of text) {
        if (++frameBytes > frameLimit)
          throw new ProtocolError("SSE frame exceeds deployed payload budget");
        if (char === "\n" && carriage) {
          carriage = false;
          continue;
        }
        if (char === "\r" || char === "\n") {
          await finishLine();
          carriage = char === "\r";
        } else {
          carriage = false;
          line += char;
        }
      }
    }
    decoder.decode(); // Reject truncated UTF-8; an incomplete SSE event is never delivered.
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class EventsClient {
  constructor(
    readonly http: ClientHttp,
    readonly payloadBytes: number,
    readonly restore?: () => Promise<void>,
  ) {}
  async subscribe(
    receive: (event: LiveNotification) => void | Promise<void>,
    options: {
      signal?: AbortSignal;
      sourceId?: string;
      connectionId?: string;
      jobId?: string;
      reconnect?: boolean;
    } = {},
  ): Promise<void> {
    const query = new URLSearchParams();
    for (const key of ["sourceId", "connectionId", "jobId"] as const)
      if (options[key]) query.set(key, options[key]);
    let restored = false;
    while (!options.signal?.aborted) {
      try {
        const response = await this.http.fetch(
          `${this.http.appPath}/events${query.size ? `?${query}` : ""}`,
          options.signal ? { signal: options.signal } : {},
        );
        if (response.status === 401 && response.headers.get("X-Integration-Error") === "1") {
          await response.body?.cancel();
          if (this.restore && !restored) {
            restored = true;
            await this.restore();
            continue;
          }
          throw new ServiceError(
            401,
            "authentication-required",
            "Sign in to reconnect live events",
            "",
          );
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new ServiceError(
            response.status,
            "events-unavailable",
            "Live events are unavailable",
            "",
          );
        }
        await consumeEvents(response, this.payloadBytes, receive);
      } catch (error) {
        if (options.signal?.aborted) return;
        if (
          error instanceof ProtocolError ||
          (error instanceof ServiceError && [401, 403, 404].includes(error.status))
        )
          throw error;
        if (!options.reconnect) throw error;
      }
      if (!options.reconnect) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, 1000 + Math.floor(Math.random() * 500));
        options.signal?.addEventListener("abort", done, { once: true });
        if (options.signal?.aborted) done();
      });
    }
  }
}
