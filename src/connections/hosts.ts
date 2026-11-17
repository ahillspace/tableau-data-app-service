import { invalid, ServiceError } from "../platform/errors.ts";
/** Normalized HTTPS base URLs, with at most one wildcard inside the leftmost DNS label. */
export function normalizeApiHost(value: unknown, pattern = true): string | undefined {
  if (typeof value !== "string" || value.length > 2000 || /[\\\s]/u.test(value)) return undefined;
  // Check before URL normalization, which would otherwise erase dot segments.
  const rawPath = value.replace(/^https:\/\/[^/]+/i, "");
  if (/%(?:2e|2f|5c)/i.test(rawPath) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname
  )
    return undefined;
  if (url.hostname.includes("*")) {
    const labels = url.hostname.split(".");
    if (
      !pattern ||
      labels.length < 3 ||
      (url.hostname.match(/\*/g) ?? []).length !== 1 ||
      !labels[0]?.includes("*") ||
      !/^[a-z0-9*-]+$/.test(labels[0])
    )
      return undefined;
    if (labels.slice(1).some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))
      return undefined;
  }
  return url.href.replace(/\/+$/, "");
}

export function matchesApiHost(configured: string, selected: string): boolean {
  const pattern = normalizeApiHost(configured);
  const concrete = normalizeApiHost(selected, false);
  if (!pattern || !concrete) return false;
  const a = new URL(pattern),
    b = new URL(concrete);
  if (a.protocol !== b.protocol || a.port !== b.port) return false;
  const hostPattern = a.hostname
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[a-z0-9-]+");
  if (!new RegExp(`^${hostPattern}$`).test(b.hostname)) return false;
  const path = a.pathname.replace(/\/$/, "");
  return path === "" || b.pathname === path || b.pathname.startsWith(`${path}/`);
}

export function selectApiHost(hosts: string[], requested?: string): string {
  if (requested === undefined) {
    const exact = hosts.find((host) => !new URL(host).hostname.includes("*"));
    if (!exact)
      throw new ServiceError(400, "host-selection-required", "Select a concrete API host");
    return exact;
  }
  const concrete = normalizeApiHost(requested.trim(), false);
  if (!concrete || !hosts.some((host) => matchesApiHost(host, concrete)))
    throw invalid(
      [{ path: "Tableau-Service-Host", rule: "matching-api-host" }],
      "The selected host does not match the definition",
    );
  return concrete;
}
