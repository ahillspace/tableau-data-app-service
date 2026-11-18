import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { matches, remove, select } from "../connections/selectors.ts";
import type { EventValue, Selector, Webhook } from "../contracts/operator.ts";
import { ServiceError } from "../platform/errors.ts";
export type EventDelivery = {
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  now: Date;
  query?: URLSearchParams;
};
export type IncomingEvent = { id: string; type: string; account: string; payload: unknown };
export type IngestOutcome = {
  response: { status: number; contentType?: string; body?: string };
  events: IncomingEvent[];
};
const invalid = () =>
  new ServiceError(401, "event-signature-invalid", "The delivery verification did not pass");
function header(delivery: EventDelivery, name: string): string | undefined {
  const value = delivery.headers[name.toLowerCase()];
  return typeof value === "string" ? value : value?.length === 1 ? value[0] : undefined;
}
function timestamp(raw: string | undefined, tolerance: number, now: Date): string {
  if (!raw || !/^\d{1,12}$/.test(raw)) throw invalid();
  if (Math.abs(now.getTime() - Number(raw) * 1000) > tolerance * 1000)
    throw new ServiceError(
      401,
      "event-too-old",
      "The delivery timestamp is outside the verification window",
    );
  return raw;
}
function validSignature(given: string, expected: Buffer, encoding: "hex" | "base64"): boolean {
  if (encoding === "hex" ? !/^[0-9a-fA-F]{64}$/.test(given) : !/^[A-Za-z0-9+/]{43}=$/.test(given))
    return false;
  const decoded = Buffer.from(given, encoding);
  return decoded.length === expected.length && timingSafeEqual(decoded, expected);
}
function equalSecret(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  return timingSafeEqual(
    createHash("sha256").update(given).digest(),
    createHash("sha256").update(expected).digest(),
  );
}
function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new ServiceError(400, "event-invalid", "The delivery is not valid JSON");
  }
}
function batch(value: unknown, path?: Selector): unknown[] {
  if (!path) return [value];
  const items = select(value, path);
  if (!Array.isArray(items) || items.length > 1000)
    throw new ServiceError(400, "event-invalid", "The event batch is missing or excessive");
  return items;
}
function eventValue(
  value: unknown,
  config: EventValue | undefined,
  delivery: EventDelivery,
): string | undefined {
  if (!config) return undefined;
  const found =
    "literal" in config
      ? config.literal
      : "header" in config
        ? header(delivery, config.header)
        : select(value, config.json);
  return typeof found === "string" && found.length > 0 && found.length <= 2000
    ? found
    : typeof found === "number" && Number.isFinite(found)
      ? String(found)
      : undefined;
}
/** Finite verification primitives operate on original bytes, never reserialized JSON. */
export function verifyDelivery(
  config: Webhook,
  delivery: EventDelivery,
  secret: string | undefined,
): IngestOutcome {
  const handshake = config.handshake;
  if (handshake?.kind === "query-echo" && delivery.query?.has(handshake.parameter)) {
    const values = delivery.query.getAll(handshake.parameter);
    if (values.length !== 1 || (values[0]?.length ?? 0) > 2000)
      throw new ServiceError(400, "event-invalid", "The validation token is invalid");
    return {
      response: {
        status: 200,
        contentType: "text/plain; charset=utf-8",
        body: values[0] as string,
      },
      events: [],
    };
  }
  if (!secret)
    throw new ServiceError(
      409,
      "events-not-configured",
      "The definition has no verification secret",
    );
  const verification = config.verification;
  let parsed: unknown;
  if (verification.kind === "hmac") {
    const rawTimestamp = verification.timestamp
      ? timestamp(
          header(delivery, verification.timestamp.header),
          verification.timestamp.toleranceSeconds,
          delivery.now,
        )
      : undefined;
    const given = header(delivery, verification.header);
    if (!given?.startsWith(verification.prefix)) throw invalid();
    const mac = createHmac(verification.algorithm, secret);
    for (const part of verification.parts)
      mac.update(
        "literal" in part
          ? Buffer.from(part.literal, "utf8")
          : "rawBody" in part
            ? delivery.body
            : Buffer.from(rawTimestamp ?? "", "utf8"),
      );
    if (
      !validSignature(given.slice(verification.prefix.length), mac.digest(), verification.encoding)
    )
      throw invalid();
    parsed = parseJson(delivery.body);
  } else if (verification.kind === "compound-hmac") {
    const raw = header(delivery, verification.header);
    if (!raw || raw.length > 16384) throw invalid();
    const pieces = raw.split(",");
    if (pieces.length > 64) throw invalid();
    const members = pieces.map((piece) => {
      const at = piece.indexOf("=");
      return [piece.slice(0, at).trim(), piece.slice(at + 1).trim()] as const;
    });
    const times = members.filter(([key]) => key === verification.timestampKey);
    if (times.length !== 1) throw invalid();
    const rawTimestamp = timestamp(times[0]?.[1], verification.toleranceSeconds, delivery.now);
    const expected = createHmac("sha256", secret)
      .update(rawTimestamp)
      .update(verification.separator)
      .update(delivery.body)
      .digest();
    const signatures = members.filter(([key]) => key === verification.signatureKey);
    if (!signatures.some(([, value]) => validSignature(value, expected, "hex"))) throw invalid();
    parsed = parseJson(delivery.body);
  } else {
    parsed = parseJson(delivery.body);
    const items = batch(parsed, verification.batch);
    if (
      !items.length ||
      items.some((item) => !equalSecret(select(item, verification.secret), secret))
    )
      throw invalid();
    for (const item of items) remove(item, verification.secret);
  }
  if (handshake?.kind === "verified-json-echo" && matches(parsed, handshake.when)) {
    const value = select(parsed, handshake.value);
    if (typeof value !== "string" || value.length > 2000)
      throw new ServiceError(400, "event-invalid", "The challenge value is invalid");
    return {
      response: {
        status: 200,
        contentType:
          handshake.response === "json" ? "application/json" : "text/plain; charset=utf-8",
        body:
          handshake.response === "json"
            ? JSON.stringify({ [handshake.responseKey as string]: value })
            : value,
      },
      events: [],
    };
  }
  const items = batch(parsed, config.event.batch);
  const digest = createHash("sha256").update(delivery.body).digest("hex");
  const events: IncomingEvent[] = [];
  for (const [index, item] of items.entries()) {
    if (
      verification.kind === "body-secret" &&
      config.event.batch?.join("\0") === verification.batch.join("\0")
    )
      remove(item, verification.secret);
    for (const path of config.event.omit ?? []) remove(item, path);
    const type = eventValue(item, config.event.type, delivery);
    const account = config.event.account
      .map((value) => eventValue(item, value, delivery))
      .find(Boolean);
    if (!type || !account) continue;
    events.push({
      id: eventValue(item, config.event.id, delivery) ?? `${digest}:${index}`,
      type,
      account,
      payload: config.event.payload ? select(item, config.event.payload) : item,
    });
  }
  return { response: { status: 200 }, events };
}
