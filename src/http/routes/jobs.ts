import type { FastifyInstance } from "fastify";
import { caller, readBearer } from "../auth.ts";
import { limitQuery, objectBody, param, query } from "../request.ts";
import type { Services } from "../services.ts";

export function jobRoutes(app: FastifyInstance, services: Services): void {
  const { jobs, identity } = services;

  app.post("/v1/jobs", async (request, reply) => {
    const principal = await caller(identity, request);
    const body = objectBody(request);
    const { job, created } = await jobs.submit(principal, {
      handler: body.handler as string,
      definitionId: (body.definitionId ?? body.definition) as string,
      input: body.input,
      submissionKey: (body.submissionKey ?? body.key) as string,
    });
    return reply.status(created ? 201 : 200).send({ job, created });
  });

  app.get("/v1/jobs", async (request) => {
    const principal = await caller(identity, request);
    const state = query(request, "state");
    const limit = limitQuery(request);
    return {
      jobs: await jobs.listOwn(principal, {
        ...(state ? { state } : {}),
        ...(limit ? { limit } : {}),
      }),
    };
  });

  app.get("/v1/jobs/:id", async (request) => ({
    job: await jobs.get(await caller(identity, request), param(request, "id")),
  }));

  app.get("/v1/jobs/:id/result", async (request) => ({
    result: await jobs.result(await caller(identity, request), param(request, "id")),
  }));

  app.post("/v1/jobs/:id/cancel", async (request) => ({
    job: await jobs.cancelOwn(await caller(identity, request), param(request, "id")),
  }));

  // The external task presents the verifier the service issued for this wait, in the service's bearer header.
  app.post("/v1/jobs/callbacks/:id", async (request, reply) => {
    await jobs.callback(param(request, "id"), readBearer(request), request.body ?? null);
    return reply.status(202).send({ accepted: true });
  });
}
