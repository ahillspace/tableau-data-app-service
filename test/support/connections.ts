import { DefinitionStore } from "../../src/connections/definitions.ts";
import {
  type Capability,
  Extensions,
  type JobHandlerDefinition,
} from "../../src/connections/provider-types.ts";
import { ConnectionService } from "../../src/connections/service.ts";
import type { Db } from "../../src/persistence/database.ts";
import { Log } from "../../src/platform/log.ts";
import type { Outbound } from "../../src/platform/outbound.ts";
import type { SealingKeys } from "../../src/platform/settings.ts";
import { Sealer } from "../../src/sealing/sealer.ts";
import type { MovableClock } from "./identity.ts";

export type ConnectionsHarness = {
  connections: ConnectionService;
  definitions: DefinitionStore;
  sealer: Sealer;
  lines: string[];
};

/** One replica's connections component over a shared database. */
export function connectionsHarness(
  db: Db,
  options: {
    keys: SealingKeys;
    outbound: Outbound;
    clock: MovableClock;
    jobHandlers?: JobHandlerDefinition[];
    capabilities?: Capability[];
  },
): ConnectionsHarness {
  const lines: string[] = [];
  const log = new Log((line) => lines.push(line));
  const extensions = new Extensions({
    ...(options.jobHandlers ? { jobHandlers: options.jobHandlers } : {}),
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
  });
  const sealer = new Sealer(options.keys);
  const definitions = new DefinitionStore({ db, extensions, sealer, clock: options.clock });
  const connections = new ConnectionService({
    db,
    definitions,
    sealer,
    outbound: options.outbound,
    publicOrigin: "https://service.test",
    clock: options.clock,
    log,
  });
  return { connections, definitions, sealer, lines };
}
