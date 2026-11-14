import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bearer } from "../access/service.js";
import type { AccessContext, ApiExtension, CoreServices } from "../core-ports.js";
import { ServiceError } from "../http/errors.js";
import { jobViewSchema, opaqueId } from "../public/schemas.js";
import type { JobsService } from "./service.js";

export function jobsApi(jobs: JobsService, options: { cleanupMs: number }): ApiExtension {
  return {
    async register(app: FastifyInstance, core: CoreServices) {
      const contexts = new WeakMap<object, AccessContext>();
      const access = async (request: {
        headers: { authorization?: string | undefined };
        params: unknown;
      }) => {
        const cached = contexts.get(request);
        if (cached) return cached;
        const params = z.object({ app: opaqueId }).parse(request.params);
        return core.access.authenticate(bearer(request.headers.authorization), params.app);
      };
      // Encapsulated raw JSON parsing leaves near-cap parse/validation off the control event loop.
      await app.register(async (scope) => {
        scope.addHook("onRequest", async (request) => {
          if (request.routeOptions.url?.startsWith("/v1/apps/"))
            contexts.set(request, await access(request));
        });
        scope.removeContentTypeParser("application/json");
        const ingress = new WeakMap<object, Array<() => void>>();
        const releaseIngress = (request: object) => {
          for (const release of ingress.get(request) ?? []) release();
          ingress.delete(request);
        };
        scope.addHook("onResponse", async (request) => releaseIngress(request));
        scope.addHook("onError", async (request) => releaseIngress(request));
        scope.addContentTypeParser("application/json", (request, stream, done) => {
          const chunks: Buffer[] = [];
          const reservations: Array<() => void> = [];
          ingress.set(request, reservations);
          let bytes = 0;
          let finished = false;
          stream.on("data", (chunk: Buffer) => {
            if (finished) return;
            try {
              bytes += chunk.length;
              if (bytes > request.routeOptions.bodyLimit)
                throw new ServiceError(
                  413,
                  "job-body-too-large",
                  "Job request exceeds its transport bound",
                );
              reservations.push(jobs.options.payloads.reserve(chunk.length * 2));
              chunks.push(chunk);
            } catch (error) {
              finished = true;
              releaseIngress(request);
              done(error as Error);
              stream.resume();
            }
          });
          stream.on("error", () => {
            if (!finished) {
              finished = true;
              releaseIngress(request);
              done(new ServiceError(400, "invalid-job-body", "Job request body failed"));
            }
          });
          stream.on("end", () => {
            if (!finished) {
              finished = true;
              done(null, Buffer.concat(chunks, bytes));
            }
          });
        });
        scope.post(
          "/v1/apps/:app/jobs",
          { bodyLimit: 100000000 * 6 + 65536 },
          async (request, reply) => {
            const current = await access(request);
            if (!Buffer.isBuffer(request.body))
              throw new ServiceError(415, "json-required", "Job input requires JSON");
            const result = await jobs.admit(current, request.body);
            reply.code(result.created ? 202 : 200);
            return result.job;
          },
        );
        scope.get("/v1/apps/:app/jobs", async (request) => {
          const query = z
            .strictObject({
              appId: opaqueId.optional(),
              state: jobViewSchema.shape.state.optional(),
              capability: opaqueId.optional(),
              next: z.string().max(2048).optional(),
              limit: z.coerce.number().int().min(1).max(100).optional(),
            })
            .parse(request.query);
          return jobs.list(await access(request), {
            ...(query.appId ? { appId: query.appId } : {}),
            ...(query.state ? { state: query.state } : {}),
            ...(query.capability ? { capability: query.capability } : {}),
            ...(query.next ? { next: query.next } : {}),
            ...(query.limit ? { limit: query.limit } : {}),
          });
        });
        scope.get("/v1/apps/:app/jobs/:id", async (request) =>
          jobs.get(await access(request), z.object({ id: opaqueId }).parse(request.params).id),
        );
        scope.get("/v1/apps/:app/jobs/:id/result", async (request, reply) => {
          const lease = await jobs.resultLease(
            await access(request),
            z.object({ id: opaqueId }).parse(request.params).id,
          );
          reply.raw.once("finish", lease.dispose);
          reply.raw.once("close", lease.dispose);
          try {
            return reply.type("application/json").send(lease.body);
          } catch (error) {
            lease.dispose();
            throw error;
          }
        });
        scope.post("/v1/apps/:app/jobs/:id/cancel", async (request) =>
          jobs.cancel(
            await access(request),
            z.object({ id: opaqueId }).parse(request.params).id,
            options.cleanupMs,
          ),
        );
        for (const declaration of jobs.options.declarations) {
          const callback = declaration.external?.callback;
          if (!callback) continue;
          opaqueId.parse(callback.route);
          scope.post(
            `/v1/providers/${opaqueId.parse(declaration.providerRegistrationId)}/tasks/${callback.route}`,
            {
              bodyLimit:
                (jobs.limits.resultBytes + declaration.external!.contextLimitBytes) * 6 + 65536,
            },
            async (request) => {
              if (!Buffer.isBuffer(request.body))
                throw new ServiceError(415, "json-required", "Task callback requires JSON");
              const headers = new Headers();
              for (const [key, value] of Object.entries(request.headers))
                if (typeof value === "string") headers.set(key, value);
              return {
                status: await jobs.callback(declaration, request.body, headers, options.cleanupMs),
              };
            },
          );
        }
      });
    },
  };
}
