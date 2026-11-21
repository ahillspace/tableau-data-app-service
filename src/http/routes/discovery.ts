import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { templates } from "../../catalog/index.ts";
import type { Extensions } from "../../connections/extensions.ts";
import type { ConnectionStatus } from "../../connections/service.ts";
import type { Definition } from "../../connections/types.ts";
import { API_MAJOR, authenticationMethods } from "../../extensions/provider.ts";
import { signInRequired } from "../../identity/sessions.ts";
import type { Principal } from "../../identity/types.ts";
import { BEARER_HEADER, readBearer } from "../auth.ts";
import type { Services } from "../services.ts";

type CliArtifact = {
  filename: string;
  version: string;
  bytes: number;
  sha256: string;
  nodeRange: string;
};

const releaseFiles = new URL("../../../dist/", import.meta.url);
const links = {
  sdk: "/v1/tools/sdk/index.js",
  sdkTypes: "/v1/tools/sdk/index.d.ts",
  sdkContractTypes: "/v1/tools/contracts/operator.d.ts",
  sdkExample: "/v1/tools/example/index.html",
  documentation: "/v1/tools/specification.html",
  viewerSignIn: "/v1/tools/specification.html#documents/events-sdk",
  operatorSignIn: "/v1/tools/specification.html#documents/running",
};
const assets = [
  [links.sdk, "sdk/index.js", "text/javascript"],
  [links.sdkTypes, "sdk/sdk/index.d.ts", "text/plain"],
  [links.sdkContractTypes, "sdk/contracts/operator.d.ts", "text/plain"],
  [links.sdkExample, "release/example/index.html", "text/html"],
  [links.documentation, "release/specification.html", "text/html"],
] as const;

const nativeHref = (id: string) => `/v1/native/${encodeURIComponent(id)}`;

function operations(
  extensions: Extensions,
  definition: Definition & { retired?: boolean },
  connection: ConnectionStatus | "per-viewer",
  operator: boolean,
) {
  return Object.entries(definition.operations ?? {}).flatMap(([name, binding]) => {
    if (!binding.enabled && !operator) return [];
    const resolved = extensions.resolve(name, binding, definition);
    const installed = resolved.installed;
    const operation = installed?.operation;
    const reason = !binding.enabled
      ? "detached"
      : definition.retired
        ? "definition-retired"
        : !definition.enabled
          ? "definition-disabled"
          : resolved.ready
            ? undefined
            : resolved.reason;
    const needsConnection = operation?.requirements?.connection && connection !== "connected";
    const state = reason
      ? reason === "detached"
        ? "detached"
        : "unavailable"
      : needsConnection
        ? definition.ownership === "personal"
          ? "connect_required"
          : "setup_required"
        : "available";
    return [
      {
        name,
        state,
        ...(reason ? { reason } : needsConnection ? { reason: connection } : {}),
        method: "POST",
        href: `/v1/capabilities/${encodeURIComponent(definition.id)}/${encodeURIComponent(name)}`,
        contractMajor: binding.contractMajor,
        ...(installed
          ? {
              contract: {
                contractMajor: installed.contract.contractMajor,
                description: installed.contract.description,
                input: installed.contract.input,
                output: installed.contract.output,
                example: installed.contract.example,
                errors: [
                  "invalid-request",
                  "capability-not-found",
                  "capability-unavailable",
                  "capability-failed",
                  "capability-result-invalid",
                  ...(operation?.requirements?.connection
                    ? ["not-connected", "needs-authorization"]
                    : []),
                  ...installed.contract.errors,
                ],
                ...(operator ? { options: installed.contract.options } : {}),
              },
            }
          : {}),
        ...(operator
          ? {
              options: binding.options,
              ...(reason === "operation-missing" || reason === "contract-major-mismatch"
                ? {
                    remediation: {
                      packageId: name.split(".")[0],
                      definitionHref: `/v1/admin/definitions/${encodeURIComponent(definition.id)}`,
                    },
                  }
                : {}),
            }
          : {}),
      },
    ];
  });
}

async function serviceViews(services: Services, principal: Principal) {
  const operator = principal.kind === "operator";
  const contributions = await Promise.all(
    (services.services ?? []).map(async ({ id, contractHref, mounted }) => {
      if (!mounted) return operator ? { id, state: "disabled" } : undefined;
      const view = await mounted.discover(principal);
      return view && { id, contractHref, ...view };
    }),
  );
  return contributions.filter((view) => view !== undefined);
}

export async function discoveryRoutes(app: FastifyInstance, services: Services): Promise<void> {
  const artifact = JSON.parse(
    await readFile(new URL("release/cli.json", releaseFiles), "utf8"),
  ) as CliArtifact;
  const { filename, version, bytes, sha256, nodeRange } = artifact;
  if (filename !== `tdas-cli-${version}.tgz`) throw new Error("Invalid CLI artifact filename");
  const archive = await readFile(new URL(`release/${filename}`, releaseFiles));
  if (archive.byteLength !== bytes || createHash("sha256").update(archive).digest("hex") !== sha256)
    throw new Error("CLI artifact does not match its release manifest");
  const archiveHref = `/v1/tools/${filename}`;
  app.get(archiveHref, async (_request, reply) =>
    reply
      .type("application/gzip")
      .header("content-disposition", `attachment; filename="${filename}"`)
      .send(archive),
  );
  await Promise.all(
    assets.map(async ([href, file, type]) => {
      const body = await readFile(new URL(file, releaseFiles));
      app.get(href, async (_request, reply) => reply.type(type).send(body));
    }),
  );

  const publicView = {
    discoveryVersion: 1,
    apiMajor: API_MAJOR,
    serverVersion: version,
    supported: { authentication: authenticationMethods, ownership: ["shared", "personal"] },
    cli: {
      version,
      href: archiveHref,
      bytes,
      sha256,
      nodeRange,
      prerequisites: [
        "npm registry access for runtime dependencies",
        "A system credential store for operator sign-in",
      ],
      install: "Download the archive, verify SHA-256, then run npm install ./tdas-cli.tgz.",
    },
    links,
  };

  app.get("/v1/discovery", async (request, reply) => {
    reply.header("vary", BEARER_HEADER);
    if (request.headers[BEARER_HEADER] === undefined) return publicView;
    reply.header("cache-control", "private, no-store");
    const bearer = readBearer(request);
    const signedIn = await services.identity.authenticate(bearer);
    if (!signedIn) throw signInRequired();
    const principal =
      signedIn.kind === "operator"
        ? await services.identity.authenticateOperator(bearer)
        : signedIn;
    const operator = principal.kind === "operator";
    const extensions = services.connections.definitions.extensions;
    const install = {
      definitionsHref: "/v1/definitions",
      jobsHref: "/v1/jobs",
      ...(services.events?.ready ? { eventsHref: "/v1/events/stream" } : {}),
      ...(operator && services.consoleEnabled ? { consoleHref: "/console" } : {}),
    };
    const serviceState = await serviceViews(services, principal);
    if (operator) {
      const definitions = await services.connections.definitions.listForOperators();
      return {
        ...publicView,
        install,
        services: serviceState,
        providers: definitions.map((definition) => {
          const status =
            definition.authentication.method === "none"
              ? "connected"
              : definition.ownership === "personal"
                ? "per-viewer"
                : definition.setup.missing.length === 0
                  ? "connected"
                  : definition.credential.set
                    ? "needs-authorization"
                    : "not-connected";
          return {
            ...definition,
            connection: { status },
            nativeHref: nativeHref(definition.id),
            operations: operations(extensions, definition, status, true),
          };
        }),
        operator: {
          packages: extensions.packages(),
          events: services.events
            ? services.events.ready
              ? "available"
              : "unavailable"
            : "disabled",
          links: {
            definitions: "/v1/admin/definitions",
            connections: "/v1/admin/connections",
            presets: "/v1/admin/catalog",
          },
          presets: templates.map(({ id, name }) => ({ id, name })),
        },
      };
    }
    const providers = await services.connections.appDefinitions(principal);
    return {
      ...publicView,
      install,
      services: serviceState,
      providers: providers.map(
        ({ definition, view: { status, account, authorizedAt, scopes, ...view } }) => ({
          ...view,
          connection: { status, account, authorizedAt, scopes },
          nativeHref: nativeHref(definition.id),
          operations: operations(extensions, definition, status, false),
        }),
      ),
    };
  });
}
