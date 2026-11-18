import { readFileSync } from "node:fs";
import { z } from "zod";
import { ServiceError } from "./errors.ts";
import { canonicalOrigin } from "./settings.ts";
import { fieldErrors } from "./validation.ts";

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "slug");
const contentUrl = z.string().regex(/^[A-Za-z0-9_-]{0,255}$/, "site-content-url");

const deployment = z.strictObject({
  id: slug,
  kind: z.literal("tableau-cloud", { error: "one-of:tableau-cloud" }),
  podOrigin: z
    .string()
    .refine((v) => canonicalOrigin(v)?.startsWith("https://") === true, "https-origin"),
});

const schema = z
  .strictObject({
    deployments: z.array(deployment).min(1, "min:1"),
    firstSite: z.strictObject({ deploymentId: slug, contentUrl }),
    firstOperator: z.strictObject({
      deploymentId: slug,
      siteContentUrl: contentUrl,
      username: z.string().min(1, "required").max(500, "max:500"),
    }),
    publicOrigin: z
      .string()
      .refine((v) => canonicalOrigin(v) !== undefined, "https-origin")
      .optional(),
    signInLimit: z.number().int("integer").positive("min:1").optional(),
  })
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    value.deployments.forEach((d, i) => {
      if (ids.has(d.id))
        ctx.addIssue({ code: "custom", message: "unique", path: ["deployments", i, "id"] });
      ids.add(d.id);
    });
    if (!ids.has(value.firstSite.deploymentId))
      ctx.addIssue({
        code: "custom",
        message: "known-deployment",
        path: ["firstSite", "deploymentId"],
      });
    if (!ids.has(value.firstOperator.deploymentId))
      ctx.addIssue({
        code: "custom",
        message: "known-deployment",
        path: ["firstOperator", "deploymentId"],
      });
  });

export type Bootstrap = z.infer<typeof schema>;
export type DeploymentConfig = Bootstrap["deployments"][number];

export function parseBootstrap(value: unknown): Bootstrap {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ServiceError(500, "invalid-bootstrap", "Bootstrap configuration is invalid", {
      fields: fieldErrors(parsed.error, "bootstrap"),
    });
  return parsed.data;
}

export function loadBootstrap(path: string): Bootstrap {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ServiceError(500, "invalid-bootstrap", "Bootstrap configuration is invalid", {
      fields: [{ path: "BOOTSTRAP", rule: "readable-file" }],
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ServiceError(500, "invalid-bootstrap", "Bootstrap configuration is invalid", {
      fields: [{ path: "bootstrap", rule: "json" }],
    });
  }
  return parseBootstrap(json);
}
