import type { z } from "zod";
import type { FieldError } from "./errors.ts";

/** Converts every zod issue into a field path and rule, never including the input value. */
export function fieldErrors(error: z.ZodError, prefix = ""): FieldError[] {
  return error.issues.map((issue) => ({
    path: [prefix, ...issue.path.map(String)].filter(Boolean).join("."),
    rule: ruleOf(issue),
  }));
}

function ruleOf(issue: z.core.$ZodIssue): string {
  // Custom messages are written as rule names; built-in messages are replaced by a stable rule.
  if (issue.code === "custom") return issue.message;
  if (issue.message && !issue.message.includes(" ")) return issue.message;
  switch (issue.code) {
    case "invalid_type":
      return issue.input === undefined ? "required" : `type:${issue.expected}`;
    case "too_small":
      return `min:${String(issue.minimum)}`;
    case "too_big":
      return `max:${String(issue.maximum)}`;
    case "invalid_format":
      return `format:${issue.format}`;
    case "invalid_value":
      return `one-of:${issue.values.map(String).join("|")}`;
    case "unrecognized_keys":
      return `unknown-field:${issue.keys.join(",")}`;
    default:
      return issue.code;
  }
}
