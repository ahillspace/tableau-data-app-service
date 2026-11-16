import { ProviderTypes } from "../connections/provider-types.ts";
import { slack } from "./slack.ts";

/** The presets this build installs. A new preset is added here and nowhere else. */
export const PRESETS = [slack] as const;

export function installedProviderTypes(): ProviderTypes {
  return new ProviderTypes(PRESETS);
}
