import { z } from "zod";
import { definitionTemplateSchema, validateDefinition } from "../connections/validation.ts";
import type { CatalogTemplate } from "../contracts/operator.ts";
import apiKey from "./templates/api-key.json" with { type: "json" };
import googleServiceAccount from "./templates/google-service-account.json" with { type: "json" };
import oauth2 from "./templates/oauth2.json" with { type: "json" };
import slackBot from "./templates/slack-bot.json" with { type: "json" };
import slackUser from "./templates/slack-user.json" with { type: "json" };

const templateSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(1000),
  definition: definitionTemplateSchema,
});

/** Fail startup on invalid repository data, before an operator receives a partial template. */
export function loadCatalog(values: readonly unknown[]): CatalogTemplate[] {
  const ids = new Set<string>();
  return values.map((value) => {
    const parsed = templateSchema.safeParse(value);
    if (!parsed.success) throw new Error("Invalid catalog template schema");
    const template = parsed.data;
    if (ids.has(template.id)) throw new Error("Duplicate catalog template ID");
    ids.add(template.id);
    // A catalog is an incomplete form. Validate its supplied combinations using neutral defaults
    // for the definition ID and missing top-level setup, without adding those defaults to the form.
    const validation = validateDefinition(
      {
        id: "catalog-validation",
        displayName: template.name,
        ownership: "shared",
        apiHosts: ["https://catalog.example.invalid"],
        authentication: { method: "none" },
        audience: [],
        ...template.definition,
      },
      { siteIds: new Set() },
    );
    if (validation.errors.length) throw new Error(`Invalid catalog template: ${template.id}`);
    return template as CatalogTemplate;
  });
}

/** JSON defaults are copied into independent runtime definitions; no provider code executes. */
export const templates = loadCatalog([slackBot, slackUser, googleServiceAccount, apiKey, oauth2]);
