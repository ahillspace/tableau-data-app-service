import { defineOperation, type ProviderPackage } from "tableau-data-app-service/provider";
import { z } from "zod";

export function fixturePackage(wait: () => Promise<void>): ProviderPackage {
  return {
    id: "fixture",
    version: "1.2.3",
    apiMajor: 1,
    operations: [
      defineOperation({
        name: "fixture.lookup.read",
        contractMajor: 1,
        description: "Look up a fixture record.",
        options: z.object({ label: z.string().min(1) }),
        input: z.strictObject({
          id: z.string(),
          wait: z.boolean().optional(),
          host: z.string().optional(),
        }),
        output: z.strictObject({ found: z.boolean() }),
        requirements: { authentication: ["static"], connection: true },
        example: { id: "example" },
        async run({ input, options, upstream }) {
          if (input.wait) await wait();
          const response = await upstream.request({
            method: "GET",
            path: `/lookup/${encodeURIComponent(input.id)}`,
            ...(input.host ? { host: input.host } : {}),
            headers: [
              ["X-Fixture", options.label],
              ["Tableau-Service-Authorization", "fixture-internal"],
            ],
          });
          return JSON.parse(
            await response.body.toArray().then((chunks) => Buffer.concat(chunks).toString()),
          );
        },
      }),
    ],
  };
}
