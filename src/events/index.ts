import type { ConnectionService } from "../connections/service.ts";
import type { Principal } from "../identity/types.ts";
import type { Clock } from "../platform/clock.ts";
import type { Log } from "../platform/log.ts";
import { EventService } from "./service.ts";

/**
 * Events exist only when Redis is configured. With no `REDIS_URL` this returns undefined without
 * importing the Redis module, so an installation with events off never creates a Redis client.
 */
export async function createEvents(options: {
  redisUrl: string | undefined;
  connections: ConnectionService;
  clock: Clock;
  log: Log;
  sessionValid(principal: Principal): Promise<boolean>;
}): Promise<EventService | undefined> {
  if (!options.redisUrl) return undefined;
  const { RedisEventBus } = await import("./redis.ts");
  const log = options.log.child({ component: "events" });
  return new EventService({
    bus: new RedisEventBus({ url: options.redisUrl, log }),
    connections: options.connections,
    clock: options.clock,
    log,
    sessionValid: options.sessionValid,
  });
}
