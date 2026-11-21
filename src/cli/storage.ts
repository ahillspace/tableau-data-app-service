import { link, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { hashToken, randomToken } from "../platform/secrets.ts";
import { canonicalOrigin } from "../platform/settings.ts";
import { ApiError, type CliDeps, type Client, type Options, signedIn, UsageError } from "./auth.ts";

export const storageUsage = `Storage authoring (tdas login --viewer):
  storage create --name <label>                           Create and save tdas-storage.json
  storage list
  storage show
  storage rename --name <label>
  storage archive|unarchive
  storage migrate --file <sql> [--migration-id <id>] [--predecessor <revision>]
  storage query --file <sql> [--values <json-array>]
  storage schema [--output <file> | --describe]
  storage graphql --file <document> [--variables <json-object>] [--operation-name <name>]
  storage identities --username <username>
  storage access --file <json>                             Set sharing with the current access version

  Workspace commands use tdas-storage.json by default. Use --config <file> or --workspace <id>.

Storage operations (tdas login):
  storage status
  storage enable|disable <siteId>
  storage suspend|resume|retire <workspaceId>
  storage purge <workspaceId> --confirm <workspaceId>
  storage transfer <workspaceId> <identityId>`;

const configName = "tdas-storage.json";
const storage = "/v1/storage/workspaces";
const admin = "/v1/admin/storage";

type Creation = { label: string; key: string; creator: string };
type Config = {
  service: string;
  workspaceId?: string;
  roles?: { reader: string; editor: string };
  creation?: Creation;
};

type Workspace = {
  id: string;
  label: string;
  revision: number;
  roles?: Config["roles"];
  migrations?: { id: string; predecessor: number }[];
};
type WorkspaceResponse = { workspace: Workspace };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new UsageError(`Missing ${what}`);
  return value;
}

function workspaceLabel(value: string | undefined): string {
  const label = need(value?.trim(), "--name");
  if (label.length > 200) throw new UsageError("--name accepts up to 200 characters");
  return label;
}

function pathId(value: string): string {
  if (value === "." || value === "..") throw new UsageError("Invalid Storage ID");
  return encodeURIComponent(value);
}

function json(value: string, what: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new UsageError(`${what} is not valid JSON`);
  }
}

async function readConfig(file: string, optional: boolean): Promise<Config | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const value = json(text, file);
  if (!object(value) || typeof value.service !== "string")
    throw new UsageError(`Invalid Storage workspace config in ${file}`);
  const service = canonicalOrigin(value.service);
  if (
    !service ||
    (value.workspaceId !== undefined &&
      (typeof value.workspaceId !== "string" || !value.workspaceId)) ||
    (value.creation !== undefined &&
      (!object(value.creation) ||
        typeof value.creation.label !== "string" ||
        typeof value.creation.key !== "string" ||
        typeof value.creation.creator !== "string")) ||
    (!value.workspaceId && !value.creation)
  )
    throw new UsageError(`Invalid Storage workspace config in ${file}`);
  return { ...(value as Config), service };
}

async function writeConfig(file: string, config: Config, replace: boolean): Promise<void> {
  const staging = await mkdtemp(join(dirname(file), ".tdas-storage-"));
  try {
    const staged = join(staging, configName);
    await writeFile(staged, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    if (replace) await rename(staged, file);
    else await link(staged, file);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function createWorkspace(
  client: Client,
  file: string,
  existing: Config | undefined,
  label: string,
): Promise<WorkspaceResponse> {
  const { identity } = await client.call<{
    identity: { deploymentId: string; siteId: string; userId: string };
  }>("GET", "/v1/session");
  const creator = hashToken(
    JSON.stringify([identity.deploymentId, identity.siteId, identity.userId]),
  );
  let config = existing;
  if (!config) {
    const proposed = {
      service: client.origin,
      creation: { label, key: `create-${randomToken()}`, creator },
    };
    // Persist the key before the request so a lost response can be recovered from this directory.
    try {
      await writeConfig(file, proposed, false);
      config = proposed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      config = await readConfig(file, false);
    }
  }
  const creation = config?.creation;
  if (
    config?.service !== client.origin ||
    creation?.label !== label ||
    creation.creator !== creator
  )
    throw new UsageError(`There is already a different Storage workspace setup in ${file}`);
  await mkdir(join(dirname(file), "migrations"), { recursive: true });

  const result = await client.call<WorkspaceResponse>("POST", storage, {
    label,
    creationKey: creation.key,
  });
  const { id, roles } = result.workspace;
  if (config.workspaceId && config.workspaceId !== id)
    throw new Error("The creation result did not match the workspace in the local config");
  await writeConfig(file, { ...config, workspaceId: id, ...(roles ? { roles } : {}) }, true);
  return result;
}

async function migrate(
  client: Client,
  path: string,
  file: string,
  options: Options,
): Promise<unknown> {
  const id = options.get("migration-id")?.at(-1) ?? basename(file, extname(file));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))
    throw new UsageError(
      "Use --migration-id with 1 to 128 letters, digits, dots, underscores or hyphens, starting with a letter or digit",
    );
  const specified = options.get("predecessor")?.at(-1);
  const sql = await readFile(file, "utf8");
  let predecessor: number;
  if (specified !== undefined) {
    predecessor = Number(specified);
    if (!/^\d+$/.test(specified) || !Number.isSafeInteger(predecessor))
      throw new UsageError("--predecessor requires a nonnegative integer");
  } else {
    const { workspace } = await client.call<WorkspaceResponse>("GET", path);
    predecessor =
      workspace.migrations?.find((migration) => migration.id === id)?.predecessor ??
      workspace.revision;
  }
  return client.call("POST", `${path}/migrations`, { id, predecessor, sql });
}

const adminActions = new Set([
  "status",
  "enable",
  "disable",
  "suspend",
  "resume",
  "retire",
  "purge",
  "transfer",
]);
const viewerActions = new Set([
  "create",
  "list",
  "show",
  "rename",
  "archive",
  "unarchive",
  "migrate",
  "query",
  "schema",
  "graphql",
  "identities",
  "access",
]);

async function adminCommand(
  client: Client,
  action: string,
  [first, second, extra]: string[],
  confirmation?: string,
) {
  if (extra !== undefined || (second !== undefined && action !== "transfer"))
    throw new UsageError("Unexpected Storage operator arguments");
  if (action === "status") {
    if (first !== undefined) throw new UsageError("storage status takes no arguments");
    return client.call("GET", admin);
  }
  if (action === "enable" || action === "disable") {
    return client.call("PUT", `${admin}/sites/${pathId(need(first, "site ID"))}`, {
      enabled: action === "enable",
    });
  }
  const path = `${admin}/workspaces/${pathId(need(first, "workspace ID"))}`;
  if (action === "purge") {
    if (confirmation !== first)
      throw new UsageError("Purging workspace data requires --confirm with the same workspace ID");
    return client.call("DELETE", path, { confirm: confirmation });
  }
  if (action === "transfer")
    return client.call("PATCH", path, { ownerId: need(second, "identity ID") });
  const state = action === "suspend" ? "suspended" : action === "resume" ? "active" : "retired";
  return client.call("PATCH", path, { state });
}

export async function storageCommand(
  deps: CliDeps,
  action: string | undefined,
  args: string[],
  options: Options,
): Promise<void> {
  const print = (value: unknown) => deps.out(JSON.stringify(value, null, 2));
  if (!action) throw new UsageError("Choose a Storage command");
  if (adminActions.has(action)) {
    if (options.has("viewer"))
      throw new UsageError("This Storage command requires operator sign-in");
    for (const name of options.keys()) {
      if (name !== "service" && name !== "operator" && !(action === "purge" && name === "confirm"))
        throw new UsageError(`--${name} is not an option for this Storage operator command`);
    }
    return print(
      await adminCommand(
        await signedIn(deps, options),
        action,
        args,
        options.get("confirm")?.at(-1),
      ),
    );
  }
  if (!viewerActions.has(action)) throw new UsageError(`Unknown Storage command: ${action}`);
  if (options.has("operator")) throw new UsageError("This Storage command requires viewer sign-in");
  if (args.length) throw new UsageError(`Unexpected Storage argument: ${args[0]}`);
  const flag = (name: string) => options.get(name)?.at(-1);
  const file = flag("config") ?? configName;
  const id = flag("workspace");
  if (id && (action === "create" || action === "list" || options.has("config")))
    throw new UsageError("--workspace selects an existing workspace in place of the config");
  if (action === "list" && !options.has("config"))
    return print(await (await signedIn(deps, options, "viewer")).call("GET", storage));
  const config = id
    ? undefined
    : await readConfig(file, !options.has("config") || action === "create");
  const client = await signedIn(deps, options, "viewer", config?.service);
  if (config && config.service !== client.origin)
    throw new UsageError(`${file} selects the service ${config.service}`);
  if (action === "create")
    return print(await createWorkspace(client, file, config, workspaceLabel(flag("name"))));
  if (action === "list") return print(await client.call("GET", storage));
  const workspace = id ?? config?.workspaceId;
  if (!workspace)
    throw new UsageError("Select a workspace with --workspace or run tdas storage create");
  const path = `${storage}/${pathId(workspace)}`;
  const inputFile = () => need(flag("file"), "--file");
  switch (action) {
    case "show":
      return print(await client.call("GET", path));
    case "rename":
      return print(await client.call("PATCH", path, { label: workspaceLabel(flag("name")) }));
    case "archive":
    case "unarchive":
      return print(
        await client.call("PATCH", path, {
          state: action === "archive" ? "archived" : "active",
        }),
      );
    case "migrate":
      return print(await migrate(client, path, inputFile(), options));
    case "query": {
      const sql = await readFile(inputFile(), "utf8");
      const input = flag("values");
      const values = input === undefined ? undefined : json(input, "--values");
      if (values !== undefined && !Array.isArray(values))
        throw new UsageError("--values requires a JSON array");
      return print(await client.call("POST", `${path}/query`, { sql, values }));
    }
    case "schema": {
      const output = flag("output");
      if (output && options.has("describe"))
        throw new UsageError("Choose either --output or --describe");
      if (options.has("describe"))
        return print(await client.call("GET", `${path}/schema?view=model`));
      const schema = await client.call<{ sdl: string }>("GET", `${path}/schema`);
      if (output) return writeFile(output, schema.sdl);
      return deps.out(schema.sdl);
    }
    case "graphql": {
      const query = await readFile(inputFile(), "utf8");
      const input = flag("variables");
      const variables = input === undefined ? undefined : json(input, "--variables");
      if (variables !== undefined && !object(variables))
        throw new UsageError("--variables requires a JSON object");
      const result = await client.call<{ errors?: unknown[] }>("POST", `${path}/graphql`, {
        query,
        variables,
        operationName: flag("operation-name"),
      });
      if (result.errors?.length) throw new ApiError(200, result, "viewer");
      return print(result);
    }
    case "identities": {
      const query = new URLSearchParams({ username: need(flag("username"), "--username") });
      return print(await client.call("GET", `${path}/identities?${query}`));
    }
    case "access": {
      const input = inputFile();
      return print(
        await client.call("PUT", `${path}/access`, json(await readFile(input, "utf8"), input)),
      );
    }
  }
}
