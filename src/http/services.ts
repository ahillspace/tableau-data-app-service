import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ConnectionService } from "../connections/service.ts";
import type { EventService } from "../events/service.ts";
import type { IdentityService } from "../identity/sessions.ts";
import type { Principal } from "../identity/types.ts";
import type { JobService } from "../jobs/service.ts";
import type { Metrics } from "../operations/metrics.ts";
import type { Operations } from "../operations/status.ts";
import type { Db } from "../persistence/database.ts";
import type { Log } from "../platform/log.ts";
import type { NativeRouter } from "../router/router.ts";

export type ServiceDiscovery = {
  state: "available" | "unavailable";
  reason?: string;
  canCreate?: boolean;
  actions?: readonly { method: string; href: string }[];
};

type MountedService = {
  routes(app: FastifyInstance): void | Promise<void>;
  discover(
    principal: Principal,
  ): ServiceDiscovery | undefined | Promise<ServiceDiscovery | undefined>;
  close?(): Promise<void>;
};

export type ServiceGuards = {
  requireCaller(request: FastifyRequest): Promise<Principal>;
  requireOperator(request: FastifyRequest): Promise<Principal>;
};

export type ServiceDeployment = {
  id: string;
  contractHref: string;
  publicHref?: string;
  /** Omit open to declare a deployed but disabled service. */
  open?(guards: ServiceGuards): Promise<MountedService> | MountedService;
};

export type ServiceContribution = Pick<ServiceDeployment, "id" | "contractHref" | "publicHref"> & {
  mounted?: MountedService;
};

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
  consoleEnabled?: boolean;
  metrics?: Metrics;
  operations?: Operations;
  services?: readonly ServiceContribution[];
};
