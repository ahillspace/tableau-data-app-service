import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createApplication } from "../src/application.js";
import {
  applicationConfigSchema,
  applyConfiguration,
  assertConfiguration,
} from "../src/application-config.js";
import { testPostgres } from "./postgres.js";

test("composed Slack application runs auth/proxy discovery with Jobs and Redis off, refuses enrollment, and rejects silent deployment retargeting", async () => {
  const settings = applicationConfigSchema.parse(
    JSON.parse(await readFile(new URL("../service-config.example.json", import.meta.url), "utf8")),
  );
  const f = await testPostgres();
  let application: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    await applyConfiguration(f.db, settings);
    await applyConfiguration(f.db, settings);
    await assertConfiguration(f.db, settings, f.config);
    application = await createApplication(f.config, settings, {});
    assert.equal(application.jobs, undefined);
    assert.equal(await application.events.health(), "disabled");
    assert.equal((await application.app.inject({ url: "/health/ready" })).statusCode, 200);
    const blocked = await application.app.inject({
      method: "POST",
      url: "/v1/session/transactions",
      payload: {
        appId: "slack-example",
        deploymentId: "tableau-cloud",
        initiationVerifier: "a".repeat(64),
      },
    });
    assert.equal(blocked.statusCode, 503);
    assert.equal(blocked.json().error.code, "initial-enrollment-unavailable");
    assert.equal(
      (await application.app.inject({ url: "/v1/apps/slack-example/jobs" })).statusCode,
      404,
    );
    await f.db
      .insertInto("tableau_sites")
      .values({ id: "site-row", deployment_id: "tableau-cloud", site_id: "site", enabled: true })
      .execute();
    const identity = await application.sessions.access.createSession(
      {
        deploymentId: "tableau-cloud",
        siteId: "site",
        subjectId: "alice",
        verifiedAt: new Date(),
        adapterId: "tableau-cloud",
      },
      "slack-example",
    );
    const headers = { authorization: `Bearer ${identity.token}` };
    const providers = await application.app.inject({
      url: "/v1/apps/slack-example/providers",
      headers,
    });
    assert.equal(providers.statusCode, 200);
    assert.equal(providers.json().events, undefined);
    assert.deepEqual(providers.json().items[0].setupModes, ["static"]);
    assert.deepEqual(
      (
        await application.app.inject({ url: "/v1/apps/slack-example/capabilities", headers })
      ).json(),
      { items: [] },
    );
    const retargeted = structuredClone(settings);
    const deployment = retargeted.deployments[0];
    assert.ok(deployment?.kind === "cloud");
    deployment.podOrigin = "https://another.online.tableau.com";
    await assert.rejects(applyConfiguration(f.db, retargeted), /continuity/);
    await assert.rejects(assertConfiguration(f.db, retargeted, f.config), /differs/);
    const missing = structuredClone(settings);
    missing.apps.push({ ...missing.apps[0]!, id: "missing" });
    await assert.rejects(assertConfiguration(f.db, missing, f.config), /differs/);
  } finally {
    await application?.close();
    await f.close();
  }
});
