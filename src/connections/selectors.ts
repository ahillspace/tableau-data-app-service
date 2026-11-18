import type { Predicate, Selector } from "./types.ts";
/** Only own properties are readable; selectors never traverse prototypes. */
export function select(value: unknown, path: Selector): unknown {
  for (const key of path) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
export function matches(value: unknown, predicate: Predicate): boolean {
  const found = select(value, predicate.path);
  return "equals" in predicate
    ? found === predicate.equals
    : (found !== undefined) === predicate.exists;
}
export function firstText(value: unknown, paths?: Selector[]): string | undefined {
  for (const path of paths ?? []) {
    const found = select(value, path);
    if (typeof found === "string" && found.length > 0 && found.length <= 2000) return found;
  }
  return undefined;
}
export function remove(value: unknown, path: Selector): void {
  const owner = path.length > 1 ? select(value, path.slice(0, -1)) : value;
  if (owner && typeof owner === "object")
    delete (owner as Record<string, unknown>)[path.at(-1) as string];
}
