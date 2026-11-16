import { DefinitionStore } from "../../src/connections/definitions.ts";
import { type ProviderType, ProviderTypes } from "../../src/connections/provider-types.ts";
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
  options: { keys: SealingKeys; outbound: Outbound; clock: MovableClock; presets?: ProviderType[] },
): ConnectionsHarness {
  const lines: string[] = [];
  const log = new Log((line) => lines.push(line));
  const types = new ProviderTypes(options.presets ?? []);
  const definitions = new DefinitionStore({ db, types, clock: options.clock });
  const sealer = new Sealer(options.keys);
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
