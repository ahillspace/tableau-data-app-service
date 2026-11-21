import { Extensions } from "../connections/extensions.ts";

/** Import trusted provider packages and Job handlers here to enable them for this deployment. */
export function installedExtensions(): Extensions {
  return new Extensions();
}
