import type { EventProvider } from "./events/types.js";
import type { JobDeclaration } from "./jobs/types.js";
import type { ProviderRegistration } from "./providers/registry.js";

// Additional trusted declarations are installed in source. The browser and
// configuration files cannot load modules, select fixture identities or add Jobs.
export type InstalledDeclarations = {
  providers: readonly ProviderRegistration[];
  jobs: readonly JobDeclaration[];
  events: ReadonlyMap<string, EventProvider>;
};
export const installedDeclarations: InstalledDeclarations = {
  providers: [],
  jobs: [],
  events: new Map(),
};
