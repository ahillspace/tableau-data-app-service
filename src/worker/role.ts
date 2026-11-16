import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { JobWorker } from "../jobs/worker.ts";
import { type Db, databaseTime } from "../persistence/database.ts";
import type { Log } from "../platform/log.ts";
import type { Maintenance } from "./maintenance.ts";

export const MAINTENANCE_INTERVAL_MS = 60_000;
/** Maintenance counts as recent within this window; three missed passes make the worker unready. */
const MAINTENANCE_FRESH_MS = 3 * MAINTENANCE_INTERVAL_MS + 30_000;

/**
 * The worker role: runs Jobs, runs maintenance on an interval, and serves its own health routes.
 * Ready means the database answers and maintenance has run recently.
 */
export class WorkerRole {
  readonly #db: Db;
  readonly #worker: JobWorker;
  readonly #maintenance: Maintenance;
  readonly #log: Log;
  readonly #intervalMs: number;
  readonly #freshMs: number;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #server: Server | undefined;

  constructor(options: {
    db: Db;
    worker: JobWorker;
    maintenance: Maintenance;
    log: Log;
    intervalMs?: number;
  }) {
    this.#db = options.db;
    this.#worker = options.worker;
    this.#maintenance = options.maintenance;
    this.#log = options.log;
    this.#intervalMs = options.intervalMs ?? MAINTENANCE_INTERVAL_MS;
    this.#freshMs = options.intervalMs ? 3 * options.intervalMs + 1000 : MAINTENANCE_FRESH_MS;
  }

  async start(healthPort: number, host = "0.0.0.0"): Promise<number> {
    this.#worker.start();
    this.#maintain();
    this.#timer = setInterval(() => this.#maintain(), this.#intervalMs);
    this.#server = createServer((req, res) => {
      void this.#health(req.method ?? "GET", (req.url ?? "/").split("?")[0] as string).then(
        ({ status, body }) => {
          res.writeHead(status, {
            "content-type": "application/json",
            "cache-control": "no-store",
          });
          res.end(JSON.stringify(body));
        },
      );
    });
    await new Promise<void>((resolve) => this.#server?.listen(healthPort, host, resolve));
    return (this.#server.address() as AddressInfo).port;
  }

  #maintain(): void {
    if (this.#running) return;
    this.#running = this.#maintenance
      .run()
      .then(() => undefined)
      .catch((error: unknown) => this.#log.error("maintenance failed", { error }))
      .finally(() => {
        this.#running = undefined;
      });
  }

  async #health(method: string, path: string): Promise<{ status: number; body: unknown }> {
    if (method !== "GET")
      return { status: 405, body: { error: { code: "method-not-allowed", message: "Use GET" } } };
    if (path === "/health/live") return { status: 200, body: { status: "live" } };
    if (path !== "/health/ready")
      return { status: 404, body: { error: { code: "not-found", message: "No such route" } } };
    const database = await databaseTime(this.#db).then(
      () => true,
      () => false,
    );
    const maintenance = Date.now() - this.#maintenance.lastRun <= this.#freshMs;
    const ready = database && maintenance;
    return {
      status: ready ? 200 : 503,
      body: { status: ready ? "ready" : "not-ready", checks: { database, maintenance } },
    };
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer);
    await this.#worker.stop();
    await this.#running;
    await new Promise<void>((resolve) => {
      if (!this.#server) return resolve();
      this.#server.closeAllConnections();
      this.#server.close(() => resolve());
    });
  }
}
