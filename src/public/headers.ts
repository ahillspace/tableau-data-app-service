// Shared byte budgets include encoded controls and complete physical header work.
export const HEADER_PROFILE = Object.freeze({
  version: 1 as const,
  physicalBytes: 65536,
  nativeBytes: 8192,
  pairs: 128,
  jsonBytes: 12288,
  encodedBytes: 16384,
});
export type HeaderPair = readonly [string, string];
const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const forbidden = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "content-length",
  "proxy-connection",
]);
export function isReserved(name: string): boolean {
  return name.toLowerCase().startsWith("x-integration-");
}
export function validateHeaderPairs(value: unknown): [string, string][] {
  if (!Array.isArray(value) || value.length > HEADER_PROFILE.pairs)
    throw new Error("Invalid native headers");
  let bytes = 0;
  return value.map((pair: unknown) => {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      typeof pair[1] !== "string"
    )
      throw new Error("Invalid native headers");
    const [name, field] = pair as [string, string];
    if (!token.test(name) || /[^\x09\x20-\x7e\x80-\xff]/.test(field) || isReserved(name))
      throw new Error("Invalid native header field");
    bytes += name.length + field.length + 4;
    if (bytes > HEADER_PROFILE.nativeBytes) throw new Error("Native headers exceed profile");
    return [name.toLowerCase(), field] as [string, string];
  });
}
export function allowedNativeHeader(name: string): boolean {
  return (
    !forbidden.has(name.toLowerCase()) &&
    !isReserved(name) &&
    !name.toLowerCase().startsWith("access-control-")
  );
}
export function encodeControl(value: unknown): string {
  const json = new TextEncoder().encode(JSON.stringify(value));
  if (json.byteLength > HEADER_PROFILE.jsonBytes) throw new Error("Header control exceeds profile");
  let binary = "";
  for (const byte of json) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (encoded.length > HEADER_PROFILE.encodedBytes)
    throw new Error("Header control exceeds profile");
  return encoded;
}
export function decodeControl(encoded: string): unknown {
  if (
    encoded.length > HEADER_PROFILE.encodedBytes ||
    !/^[A-Za-z0-9_-]*$/.test(encoded) ||
    encoded.length % 4 === 1
  )
    throw new Error("Invalid header control");
  const bytes = Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), (char) =>
    char.charCodeAt(0),
  );
  if (bytes.byteLength > HEADER_PROFILE.jsonBytes)
    throw new Error("Header control exceeds profile");
  const result: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (encodeControl(result) !== encoded) throw new Error("Noncanonical header control");
  return result;
}
