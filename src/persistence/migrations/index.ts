import type { Migration } from "kysely/migration";
import * as initial from "./0001-initial.ts";
import * as appSignInLoopback from "./0002-app-sign-in-loopback.ts";

/** Every migration, in order. A new table arrives as a new entry owned by its component. */
export const migrations: Record<string, Migration> = {
  "0001-initial": initial,
  "0002-app-sign-in-loopback": appSignInLoopback,
};
