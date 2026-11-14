import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { AuthorizationService } from "../src/connections/authorizations.js";
import { ConnectionService } from "../src/connections/service.js";
import { Sources } from "../src/events/sources.js";
import { PayloadProcessor } from "../src/jobs/payloads.js";
import { JobsService } from "../src/jobs/service.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { SecretBox } from "../src/security/encryption.js";
import { reencryptProtectedRecords, verifyProtectedKeys } from "../src/security/records.js";
import { randomSecret, verifier } from "../src/security/secrets.js";
import { candidate, coreFixture, fixtureProvider } from "./core-fixture.js";
import { command, jobDeclaration } from "./jobs-fixture.js";

test("offline re-encryption covers every protected owner, resumes after interruption and preserves uncertain dispatch while rejecting writers, missing keys and invalid tags", async () => {
  const f = await coreFixture();
  const keys = new Map([...f.config.keys, ["next", Buffer.alloc(32, 2)] as const]);
  const box = new SecretBox("next", keys);
  const payloads = new PayloadProcessor({
    keyId: f.config.ENCRYPTION_ACTIVE_KEY_ID,
    keys: f.config.keys,
    workingBytes: 10000000,
  });
  const provider = {
    ...fixtureProvider,
    capabilities: [
      {
        ref: jobDeclaration.ref,
        providerRegistrationId: "fixture",
        job: { inputSchema: jobDeclaration.inputSchema, resultSchema: jobDeclaration.resultSchema },
      },
    ],
    oauth: {
      metadata: {
        issuer: "https://provider.example",
        authorization_endpoint: "https://provider.example/authorize",
        token_endpoint: "https://provider.example/token",
      },
      clientId: "client",
      callbackUri: "https://service.example/callback",
      scope: "read",
      pkce: true,
      launchMayInvalidate: false,
      exchangeMayInvalidate: true,
      async parseTokenResponse() {
        return candidate();
      },
    },
  };
  const providers = new ProviderRegistry([provider]);
  const policy = {
    maxSockets: 4,
    connectTimeoutMs: 1000,
    headersTimeoutMs: 1000,
    stallTimeoutMs: 1000,
  };
  const connections = new ConnectionService(f.db, f.access, f.secrets, providers, policy);
  const core = { db: f.db, controlDb: f.db, secrets: f.secrets, access: f.access, connections };
  const jobs = new JobsService({
    core,
    payloads,
    declarations: [jobDeclaration],
    callbackOrigin: "https://service.example",
  });
  const writer = new pg.Client({
    connectionString: f.config.DATABASE_URL,
    application_name: "integration-api",
  });
  try {
    const connection = await f.credentials.publishLocal(f.alice.access, provider, candidate());
    const admitted = await jobs.admit(
      f.alice.access,
      command("reencrypt", { value: "saved-input" }, connection.id),
    );
    const authorizations = new AuthorizationService(
      f.db,
      f.access,
      f.credentials,
      providers,
      f.secrets,
      policy,
      60000,
      30000,
    );
    const proof = randomSecret();
    const attempt = await authorizations.begin(f.alice.access, {
      providerRegistrationId: "fixture",
      initiationVerifier: verifier(proof),
    });
    await authorizations.launch(attempt.id, proof);
    for (const id of ["a", "a-child"])
      await f.db
        .insertInto("session_transactions")
        .values({
          id,
          deployment_id: "cloud",
          app_id: "one",
          initiation_verifier: verifier(randomSecret()),
          state: "launched",
          state_verifier: null,
          browser_verifier: null,
          protected_state: f.secrets.seal(Buffer.from("private-protocol-state"), {
            kind: "session-transaction",
            id,
            provider: "fixture",
            revision: "1",
          }),
          expires_at: new Date(Date.now() + 60000),
          session_id: null,
          claim_token: null,
          claim_incarnation: null,
          claim_until: null,
        })
        .execute();
    const sources = new Sources(
      core,
      new Map([
        [
          "fixture",
          {
            verify: async () => {
              throw new Error("Unused");
            },
            eventValid: () => true,
            forwardingUnavailable: { status: 503 },
            verifyAssociation: async () => ({
              accountKey: "account",
              privateContext: { signingSecret: "private-source-secret" },
            }),
          },
        ],
      ]),
    );
    const source = await sources.associate(f.alice.access, {
      providerRegistrationId: "fixture",
      connectionId: connection.id,
      setup: "manual",
      inputs: {},
    });
    const ref = await f.credentials.reserve(
      f.alice.access,
      "fixture",
      "renewal",
      new Date(Date.now() + 60000),
      { connectionId: connection.id, expectedAuthorityGeneration: 1 },
    );
    const claim = await f.credentials.claim(f.alice.access, "fixture", ref, "old-process", 30000);
    await f.credentials.dispatch(f.alice.access, "fixture", ref, claim, true);
    await f.credentials.recover(ref, true);
    const options = { from: "test", to: "next", workingBytes: 10000000, writersStopped: true };
    await writer.connect();
    await assert.rejects(
      reencryptProtectedRecords(f.db, box, options),
      /sessions are still present/,
    );
    await writer.end();
    let stopped = false;
    await assert.rejects(
      reencryptProtectedRecords(f.db, box, {
        ...options,
        afterRecord: async () => {
          if (!stopped) {
            stopped = true;
            throw new Error("Simulated interruption");
          }
        },
      }),
      /Simulated interruption/,
    );
    const result = await reencryptProtectedRecords(f.db, box, options);
    assert.equal(result.verified, 6);
    assert.equal(result.changed, 5);
    await verifyProtectedKeys(f.db, box, keys, 10000000);
    await assert.rejects(verifyProtectedKeys(f.db, f.secrets, f.config.keys, 10000000), /missing/);
    const retained = await f.db
      .selectFrom("connections")
      .selectAll()
      .where("id", "=", connection.id)
      .executeTakeFirstOrThrow();
    assert.equal(retained.state, "renewal-uncertain");
    assert.equal(retained.mutation_id, ref.id);
    assert.equal(retained.bundle?.keyId, "next");
    assert.equal((await jobs.row(admitted.job.id))?.state, "queued");
    const storedJob = await jobs.db
      .selectFrom("job_payloads")
      .selectAll()
      .where("job_id", "=", admitted.job.id)
      .executeTakeFirstOrThrow();
    assert.equal(storedJob.key_id, "next");
    const plain = box.open(
      {
        v: 1,
        keyId: storedJob.key_id,
        nonce: storedJob.nonce.toString("base64url"),
        tag: storedJob.tag.toString("base64url"),
        ciphertext: storedJob.body.toString("base64url"),
      },
      jobs.binding((await jobs.row(admitted.job.id))!, "input", storedJob.revision),
    );
    assert.deepEqual(JSON.parse(plain.toString()), { value: "saved-input" });
    plain.fill(0);
    const storedSource = await sources.get(source);
    assert.ok(storedSource);
    assert.equal(storedSource.private_context.keyId, "next");
    await f.db
      .updateTable("connections")
      .set({ bundle: { ...retained.bundle!, tag: Buffer.alloc(16).toString("base64url") } })
      .where("id", "=", connection.id)
      .execute();
    await assert.rejects(reencryptProtectedRecords(f.db, box, options), /authentication failed/);
    assert.equal(
      (
        await f.db
          .selectFrom("connections")
          .select("bundle")
          .where("id", "=", connection.id)
          .executeTakeFirstOrThrow()
      ).bundle?.tag,
      Buffer.alloc(16).toString("base64url"),
    );
  } finally {
    await writer.end().catch(() => {});
    await payloads.close();
    await f.close();
  }
});
