import { writeFile } from "node:fs/promises";
import { templates } from "../src/catalog/index.ts";

/** Regenerate example operator input from the same JSON catalog the service exposes. */
for (const id of ["slack-bot", "slack-user"]) {
  const template = templates.find((t) => t.id === id);
  if (!template) throw new Error(`Missing catalog template: ${id}`);
  const definition = {
    ...structuredClone(template.definition),
    id,
    audience: ["TRUSTED_SITE_ID"],
    scopes: ["chat:write", "channels:read", "channels:history", "files:read"],
  };
  await writeFile(
    new URL(`../examples/slack/definitions/${id}.json`, import.meta.url),
    `${JSON.stringify(definition, null, 2)}\n`,
  );
}
