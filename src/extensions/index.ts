import { Extensions } from "../connections/extensions.ts";

/** Trusted capability and Job implementations register here; catalog authentication stays data. */
export function installedExtensions(): Extensions {
  return new Extensions();
}
