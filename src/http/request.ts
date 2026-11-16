import type { FastifyRequest } from "fastify";
import { invalid } from "../platform/errors.ts";

/** The JSON object body of a request. A missing body is an empty object. */
export function objectBody(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body) || Buffer.isBuffer(body))
    throw invalid([{ path: "", rule: "type:object" }]);
  return body as Record<string, unknown>;
}

export function param(request: FastifyRequest, name: string): string {
  return String((request.params as Record<string, string>)[name] ?? "");
}

export function query(request: FastifyRequest, name: string): string | undefined {
  const value = (request.query as Record<string, unknown> | undefined)?.[name];
  if (Array.isArray(value)) return value.length ? String(value[value.length - 1]) : undefined;
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function queryList(request: FastifyRequest, name: string): string[] {
  const value = (request.query as Record<string, unknown> | undefined)?.[name];
  const values = Array.isArray(value)
    ? value.map(String)
    : typeof value === "string"
      ? [value]
      : [];
  return values
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}

export function limitQuery(request: FastifyRequest): number | undefined {
  const raw = query(request, "limit");
  if (raw === undefined) return undefined;
  if (!/^\d{1,6}$/.test(raw) || Number(raw) < 1)
    throw invalid([{ path: "limit", rule: "integer:1-" }]);
  return Number(raw);
}
