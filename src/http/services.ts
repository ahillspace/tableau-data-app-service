import type { ConnectionService } from "../connections/service.ts";
import type { EventService } from "../events/service.ts";
import type { IdentityService } from "../identity/sessions.ts";
import type { JobService } from "../jobs/service.ts";
import type { Db } from "../persistence/database.ts";
import type { Log } from "../platform/log.ts";
import type { NativeRouter } from "../router/router.ts";

/** Everything the API role's HTTP layer calls. Each route group uses only the components it owns. */
export type Services = {
  db: Db;
  publicOrigin: string;
  identity: IdentityService;
  connections: ConnectionService;
  router: NativeRouter;
  jobs: JobService;
  /** Absent when events are off. */
  events: EventService | undefined;
  log: Log;
};
