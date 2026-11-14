import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AccessService, bearer } from "../access/service.js";
import type { CredentialsService } from "../connections/credentials.js";
import type { ConnectionService } from "../connections/service.js";
import { ProviderRegistry } from "../providers/registry.js";
import { HEADER_PROFILE } from "../public/headers.js";
import { opaqueId, staticConnectionInputSchema } from "../public/schemas.js";
import { TransportScope } from "../transport/native.js";
import { absent, ServiceError } from "./errors.js";
import { controls, requestAbort, sendResponse, webBody } from "./wire.js";

export function registerCoreRoutes(
  app: FastifyInstance,
  services: {
    access: AccessService;
    connections: ConnectionService;
    credentials: CredentialsService;
    providers: ProviderRegistry;
    corsOrigins: readonly string[];
    jsonPreparationBytes: number;
    eventPayloadBytes?: number;
  },
): void {
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && services.corsOrigins.includes(origin)) {
      reply
        .header("access-control-allow-origin", origin)
        .header("vary", "Origin")
        .header("access-control-allow-credentials", "true")
        .header(
          "access-control-expose-headers",
          "X-Integration-Origin, X-Integration-Error, X-Integration-Response-Metadata, Content-Type, Content-Length, Content-Encoding, Location, ETag, Content-Range, Accept-Ranges, Retry-After",
        );
      if (request.method === "OPTIONS" && request.headers["access-control-request-method"]) {
        reply
          .header("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
          .header(
            "access-control-allow-headers",
            "Authorization, Content-Type, X-Integration-Connection, X-Integration-Method, X-Integration-Request-Headers",
          )
          .status(204)
          .send();
      }
    }
  });
  const appParams = z.object({ app: opaqueId });
  app.get("/v1/apps/:app/providers", async (request) => {
    const { app: appId } = appParams.parse(request.params);
    await services.access.authenticate(bearer(request.headers.authorization), appId);
    const rows = await services.access.db
      .selectFrom("provider_registrations")
      .selectAll()
      .where("enabled", "=", true)
      .execute();
    return {
      ...(services.eventPayloadBytes === undefined
        ? {}
        : { events: { payloadBytes: services.eventPayloadBytes } }),
      items: rows.map((row) => {
        const provider = services.providers.get(row.id);
        if (provider.revision !== row.config_revision)
          throw new ServiceError(
            503,
            "configuration-incompatible",
            "Provider configuration unavailable",
          );
        return {
          id: provider.id,
          mode: provider.mode,
          endpoints: Object.keys(provider.endpoints),
          setupModes: [
            ...(provider.staticSetup ? ["static"] : []),
            ...(provider.oauth ? ["oauth"] : []),
          ],
          transport: HEADER_PROFILE,
        };
      }),
    };
  });
  app.get("/v1/apps/:app/connections", async (request) => {
    const { app: appId } = appParams.parse(request.params);
    const access = await services.access.authenticate(bearer(request.headers.authorization), appId);
    const query = z.strictObject({ provider: opaqueId.optional() }).parse(request.query);
    return {
      items: (await services.connections.list(access)).filter(
        (connection) => !query.provider || connection.providerRegistrationId === query.provider,
      ),
    };
  });
  app.get("/v1/apps/:app/connections/:id", async (request) => {
    const params = z.strictObject({ app: opaqueId, id: opaqueId }).parse(request.params);
    const access = await services.access.authenticate(
      bearer(request.headers.authorization),
      params.app,
    );
    const row = (await services.connections.list(access, params.id))[0];
    if (!row) absent();
    return row;
  });
  app.post("/v1/apps/:app/connections/:id/disconnect", async (request) => {
    const params = z.strictObject({ app: opaqueId, id: opaqueId }).parse(request.params);
    const input = z
      .strictObject({ expectedAuthorityGeneration: z.number().int().positive() })
      .parse(request.body);
    const access = await services.access.authenticate(
      bearer(request.headers.authorization),
      params.app,
    );
    await services.connections.disconnect(access, params.id, input.expectedAuthorityGeneration);
    return {
      connection: (await services.connections.list(access, params.id))[0],
      remoteRevocation: "unsupported",
    };
  });
  app.post("/v1/apps/:app/connections/static", async (request, reply) => {
    const { app: appId } = appParams.parse(request.params);
    const access = await services.access.authenticate(bearer(request.headers.authorization), appId);
    const input = staticConnectionInputSchema.parse(request.body);
    const provider = services.providers.get(input.providerRegistrationId);
    if (provider.mode !== "personal" || !provider.staticSetup)
      throw new ServiceError(422, "unsupported-setup", "Personal static setup is unsupported");
    const setup = provider.staticSetup;
    const validated = setup.inputSchema.parse(input.inputs);
    const signal = requestAbort(request, reply);
    const transport = new TransportScope(
      services.connections.policy,
      signal,
      services.connections.transportBudget,
    );
    const previous = await services.credentials.capture(access, provider, input.replacement);
    const ref = setup.remote
      ? await services.credentials.reserve(
          access,
          provider.id,
          "import",
          new Date(Math.min(access.authenticationExpiresAt.getTime(), Date.now() + 120000)),
          input.replacement,
          randomUUID(),
        )
      : undefined;
    try {
      const claim = ref
        ? await services.credentials.claim(access, provider.id, ref, randomUUID(), 60000)
        : undefined;
      if (ref && claim)
        await services.credentials.dispatch(access, provider.id, ref, claim, setup.mayInvalidate);
      const candidate = await setup.prepare(validated, {
        signal,
        request: async (urlString, init) => {
          if (!setup.remote) throw new Error("Local setup attempted provider I/O");
          const url = new URL(urlString);
          const entry = Object.entries(provider.endpoints).find(([, endpoint]) => {
            const base = new URL(endpoint.baseUrl);
            return (
              base.origin === url.origin &&
              url.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`)
            );
          });
          if (!entry) throw new Error("Setup destination is not registered");
          const [name, endpoint] = entry;
          const prefix = new URL(endpoint.baseUrl).pathname.replace(/\/$/, "");
          return transport.request(
            endpoint,
            {
              endpoint: name,
              method: z.enum(["GET", "POST"]).parse(init.method),
              path: url.pathname.slice(prefix.length),
              query: url.searchParams,
              ...(init.body !== undefined ? { body: init.body } : {}),
            },
            init.headers ?? new Headers(),
          );
        },
      });
      signal.throwIfAborted();
      const row =
        ref && claim
          ? await services.credentials.publish(access, provider, ref, claim, candidate)
          : await services.credentials.publishLocal(access, provider, candidate, previous);
      reply.status(input.replacement ? 200 : 201);
      return (await services.connections.list(access, row.id))[0];
    } catch (error) {
      if (ref) await services.credentials.recover(ref, true);
      throw error;
    } finally {
      await transport.dispose();
    }
  });
  app.get("/v1/apps/:app/capabilities", async (request) => {
    const { app: appId } = appParams.parse(request.params);
    await services.access.authenticate(bearer(request.headers.authorization), appId);
    const enabled = new Set(
      (
        await services.access.db
          .selectFrom("provider_registrations")
          .select("id")
          .where("enabled", "=", true)
          .execute()
      ).map((row) => row.id),
    );
    return {
      items: services.providers
        .all()
        .filter((provider) => enabled.has(provider.id))
        .flatMap((provider) =>
          provider.capabilities.map((capability) => ({
            ref: capability.ref,
            providerRegistrationId: provider.id,
            ...(capability.http
              ? {
                  http: {
                    input:
                      capability.http.input.kind === "json"
                        ? { kind: "json", schema: z.toJSONSchema(capability.http.input.schema) }
                        : { kind: "http" },
                    response:
                      capability.http.response.kind === "json"
                        ? { kind: "json", schema: z.toJSONSchema(capability.http.response.schema) }
                        : { kind: "http" },
                  },
                }
              : {}),
            ...(capability.job
              ? {
                  job: {
                    ...capability.job,
                    inputSchema: z.toJSONSchema(capability.job.inputSchema),
                    resultSchema: z.toJSONSchema(capability.job.resultSchema),
                  },
                }
              : {}),
          })),
        ),
    };
  });
  // The encapsulated raw parser keeps native JSON, multipart and file bytes streaming.
  void app.register(async (raw) => {
    raw.removeAllContentTypeParsers();
    raw.addContentTypeParser("*", (_request, payload, done) => done(null, payload));
    raw.route({
      method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      url: "/v1/apps/:app/proxy/:registration/:endpoint/*",
      handler: async (request, reply) => {
        const params = z
          .strictObject({
            app: opaqueId,
            registration: opaqueId,
            endpoint: opaqueId,
            "*": z.string(),
          })
          .parse(request.params);
        const control = controls(request, true);
        const prepared = await services.connections.prepare(
          bearer(request.headers.authorization),
          params.app,
          params.registration,
          control.connectionId,
        );
        const signal = requestAbort(request, reply);
        const scope = services.connections.openPrepared(prepared, params.registration, signal);
        reply.raw.once("close", () => {
          void scope.dispose();
        });
        try {
          // Router parameters are decoded. Only the matched route prefix is
          // structural; native path data must retain its original encoding.
          const target = request.raw.url ?? "";
          const queryAt = target.indexOf("?");
          const pathname = queryAt < 0 ? target : target.slice(0, queryAt);
          const path = /^\/v1\/apps\/[^/]+\/proxy\/[^/]+\/[^/]+(\/.*)$/.exec(pathname)?.[1];
          if (path === undefined)
            throw new ServiceError(400, "invalid-path", "Invalid native path");
          const body = webBody(request.body);
          const response = await scope.context.request({
            endpoint: params.endpoint,
            method: z
              .enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
              .parse(control.method),
            path,
            query: new URLSearchParams(queryAt < 0 ? "" : target.slice(queryAt + 1)),
            headers: control.headers,
            ...(body ? { body } : {}),
          });
          await sendResponse(
            reply,
            response,
            "proxy",
            control.tunneledHead,
            services.connections.policy.stallTimeoutMs,
          );
          return reply;
        } catch (error) {
          await scope.dispose(error);
          throw error;
        }
      },
    });
    raw.post("/v1/apps/:app/capabilities/:id/versions/:version/invoke", async (request, reply) => {
      const params = z
        .strictObject({ app: opaqueId, id: opaqueId, version: z.coerce.number().int().positive() })
        .parse(request.params);
      const capability = services.providers.capability(params.id, params.version);
      if (!capability.http)
        throw new ServiceError(422, "unsupported-invocation", "HTTP invocation is unsupported");
      const control = controls(request, false);
      const prepared = await services.connections.prepare(
        bearer(request.headers.authorization),
        params.app,
        capability.providerRegistrationId,
        control.connectionId,
      );
      const scope = services.connections.openPrepared(
        prepared,
        capability.providerRegistrationId,
        requestAbort(request, reply),
      );
      reply.raw.once("close", () => {
        void scope.dispose();
      });
      try {
        let input: unknown;
        if (capability.http.input.kind === "json") {
          if (
            !/^application\/(?:[\w.+-]+\+)?json(?:;|$)/i.test(request.headers["content-type"] ?? "")
          )
            throw new ServiceError(400, "json-required", "JSON input is required");
          const chunks: Buffer[] = [];
          let size = 0;
          if (request.body instanceof Readable)
            for await (const chunk of request.body) {
              const bytes = Buffer.from(chunk);
              size += bytes.length;
              if (size > services.jsonPreparationBytes)
                throw new ServiceError(
                  413,
                  "preparation-limit",
                  "JSON input exceeds configured preparation budget",
                );
              chunks.push(bytes);
            }
          try {
            input = capability.http.input.schema.parse(
              JSON.parse(Buffer.concat(chunks).toString()),
            );
          } catch {
            throw new ServiceError(400, "invalid-input", "Invalid capability input");
          }
        } else input = { headers: control.headers, body: webBody(request.body) };
        const result = await capability.http.handler(input, scope.context);
        let response: Response;
        if (capability.http.response.kind === "json") {
          const parsed = capability.http.response.schema.safeParse(result);
          if (!parsed.success)
            throw new ServiceError(
              500,
              "invalid-output",
              "Capability output is invalid; effects may be unknown",
            );
          response = Response.json(parsed.data);
        } else {
          if (!(result instanceof Response))
            throw new ServiceError(500, "invalid-output", "Capability output is invalid");
          response = result;
        }
        await sendResponse(
          reply,
          response,
          "capability",
          false,
          services.connections.policy.stallTimeoutMs,
        );
        return reply;
      } catch (error) {
        await scope.dispose(error);
        throw error;
      }
    });
  });
}
