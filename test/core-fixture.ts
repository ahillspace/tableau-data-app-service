import { z } from "zod";
import { AccessService } from "../src/access/service.js";
import { CredentialsService } from "../src/connections/credentials.js";
import type { ProviderRegistration } from "../src/providers/registry.js";
import { SecretBox } from "../src/security/encryption.js";
import { testPostgres } from "./postgres.js";

export const fixtureProvider: ProviderRegistration = {
  id: "fixture",
  revision: 1,
  mode: "personal",
  endpoints: { api: { baseUrl: "https://provider.example/api" } },
  credentialsSchema: z.strictObject({ token: z.string() }),
  contextSchema: z.record(z.string(), z.unknown()),
  attach: (snapshot) =>
    new Headers({ authorization: `Bearer ${(snapshot.credentials as { token: string }).token}` }),
  capabilities: [],
};
export async function coreFixture() {
  const pg = await testPostgres();
  try {
    await pg.db
      .insertInto("deployments")
      .values({
        id: "cloud",
        kind: "cloud",
        adapter_id: "fixture",
        config_revision: 1,
        enabled: true,
      })
      .execute();
    await pg.db
      .insertInto("tableau_sites")
      .values({ id: "site-row", deployment_id: "cloud", site_id: "site", enabled: true })
      .execute();
    await pg.db
      .insertInto("apps")
      .values([
        { id: "one", enabled: true, config_revision: 1, defaults: {} },
        { id: "two", enabled: true, config_revision: 1, defaults: {} },
      ])
      .execute();
    await pg.db
      .insertInto("provider_registrations")
      .values({
        id: "fixture",
        enabled: true,
        config_revision: 1,
        mode: "personal",
        reauth_seconds: null,
      })
      .execute();
    const access = new AccessService(pg.db, pg.config);
    const secrets = new SecretBox(pg.config.ENCRYPTION_ACTIVE_KEY_ID, pg.config.keys);
    const credentials = new CredentialsService(pg.db, access, secrets);
    const alice = await access.createSession(
      {
        deploymentId: "cloud",
        siteId: "site",
        subjectId: "alice",
        verifiedAt: new Date(Date.now() - 1000),
        adapterId: "fixture",
      },
      "one",
    );
    const bob = await access.createSession(
      {
        deploymentId: "cloud",
        siteId: "site",
        subjectId: "bob",
        verifiedAt: new Date(Date.now() - 1000),
        adapterId: "fixture",
      },
      "two",
    );
    return { ...pg, access, secrets, credentials, alice, bob };
  } catch (error) {
    await pg.close();
    throw error;
  }
}
export const candidate = (token = "secret-one") => ({
  credentials: { token },
  runtimeContext: { region: "one" },
  display: { label: "Fixture" },
  expiresAt: null,
  accountKey: "verified-fixture-account",
  verifiedReauthorization: true,
});
