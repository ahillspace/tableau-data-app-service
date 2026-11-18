import type { OutgoingRequest, Placement, StoredCredential } from "./types.ts";

function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

/**
 * Places a credential on an outgoing request the way the definition says.
 * Only the one header or query parameter the placement names is set; every other header,
 * including `Authorization` when the placement is elsewhere, is left as sent.
 */
export function placeCredential(
  request: OutgoingRequest,
  placement: Placement,
  credential: StoredCredential,
): void {
  const token =
    credential.accessToken ?? (credential.input?.kind === "token" ? credential.input.value : "");
  switch (placement.kind) {
    case "basic": {
      if (credential.input?.kind !== "basic") throw new Error("Basic credential unavailable");
      setHeader(
        request,
        "authorization",
        `Basic ${Buffer.from(`${credential.input.username}:${credential.input.password}`, "utf8").toString("base64")}`,
      );
      return;
    }
    case "bearer":
      setHeader(request, "authorization", `Bearer ${token}`);
      return;
    case "header":
      setHeader(request, placement.name, `${placement.prefix ?? ""}${token}`);
      return;
    case "query": {
      const at = request.target.indexOf("?");
      const path = at === -1 ? request.target : request.target.slice(0, at);
      const query = at === -1 ? "" : request.target.slice(at + 1);
      const kept = query
        .split("&")
        .filter((pair) => pair !== "" && decodeName(pair.split("=")[0] ?? "") !== placement.name);
      kept.push(`${encodeURIComponent(placement.name)}=${encodeURIComponent(token)}`);
      request.target = `${path}?${kept.join("&")}`;
      return;
    }
  }
}

function setHeader(request: OutgoingRequest, name: string, value: string): void {
  const lower = name.toLowerCase();
  request.headers = request.headers.filter(([n]) => n.toLowerCase() !== lower);
  request.headers.push([name, value]);
}

/** Whether a value can be carried by the placement. Header values cannot hold line breaks or NUL. */
export function placeable(placement: Placement, value: string): boolean {
  return placement.kind === "query" || !/[\r\n\0]/.test(value);
}
