import type { Migration } from "kysely/migration";
import * as initial from "./0001-initial.ts";

/** Every migration, in order. A new table arrives as a new entry owned by its component. */
export const migrations: Record<string, Migration> = {
  "0001-initial": initial,
};
