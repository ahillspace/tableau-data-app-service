import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { parseBootstrap } from "../src/platform/bootstrap.ts";
import { ServiceError } from "../src/platform/errors.ts";
import { Log } from "../src/platform/log.ts";
import { loadSettings, resolveInstallation } from "../src/platform/settings.ts";

const goodKey = randomBytes(32).toString("base64");
const goodEnv = {
  DATABASE_URL: "postgresql://u:p@db.example:5432/x",
  SEALING_KEYS: JSON.stringify({ current: "k1", keys: { k1: goodKey } }),
  PUBLIC_ORIGIN: "https://service.example",
  BOOTSTRAP: "/etc/tdas/bootstrap.json",
};

function failure(fn: () => unknown): ServiceError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ServiceError);
    return error;
  }
  assert.fail("expected a failure");
}

test("V1: settings load with defaults", () => {
  const settings = loadSettings(goodEnv);
  assert.equal(settings.publicOrigin, "https://service.example");
  assert.equal(settings.signInLimitSeconds, undefined);
  assert.deepEqual(resolveInstallation(settings, {}), {
    publicOrigin: "https://service.example",
    signInLimitSeconds: 7 * 86400,
  });
  assert.equal(
    resolveInstallation(
      { publicOrigin: undefined, signInLimitSeconds: undefined },
      { publicOrigin: "https://b.example", signInLimit: 60 },
    ).signInLimitSeconds,
    60,
  );
  const mismatch = failure(() =>
    resolveInstallation(settings, { publicOrigin: "https://other.example" }),
  );
  assert.deepEqual(mismatch.fields, [
    { path: "PUBLIC_ORIGIN", rule: "matches-bootstrap.publicOrigin" },
  ]);
  const missing = failure(() =>
    resolveInstallation({ publicOrigin: undefined, signInLimitSeconds: undefined }, {}),
  );
  assert.deepEqual(missing.fields, [{ path: "PUBLIC_ORIGIN", rule: "required" }]);
  assert.equal(settings.jobInputCap, 100 * 1024 * 1024);
  assert.equal(settings.redisUrl, undefined);
  assert.equal(settings.sealingKeys.current, "k1");
});

test("V1: every failing setting is listed with its rule and no secret value", () => {
  const secretKey = "c2VjcmV0LXZhbHVlLXRoYXQtaXMtbm90LTMyLWJ5dGVz";
  const error = failure(() =>
    loadSettings({
      DATABASE_URL: "mysql://user:hunter2-password@db/x",
      SEALING_KEYS: JSON.stringify({ current: "k1", keys: { k1: secretKey } }),
      PUBLIC_ORIGIN: "http://service.example/path",
      PORT: "99999",
      JOB_INPUT_CAP: "-1",
      REDIS_URL: "http://nope",
    }),
  );
  const fields = Object.fromEntries((error.fields ?? []).map((f) => [f.path, f.rule]));
  assert.equal(fields.DATABASE_URL, "postgres-url");
  assert.equal(fields["SEALING_KEYS.k1"], "key:base64-256-bit");
  assert.equal(fields.PUBLIC_ORIGIN, "https-origin");
  assert.equal(fields.BOOTSTRAP, "required");
  assert.equal(fields.PORT, "port");
  assert.equal(fields.JOB_INPUT_CAP, "bytes");
  assert.equal(fields.REDIS_URL, "redis-url");
  const text = JSON.stringify(error.toBody()) + error.message;
  assert.ok(!text.includes("hunter2"));
  assert.ok(!text.includes(secretKey));
});

test("V1: bootstrap validation lists every failing field", () => {
  const error = failure(() =>
    parseBootstrap({
      deployments: [
        { id: "cloud-west", kind: "tableau-server", podOrigin: "http://pod", clientId: "c" },
        {
          id: "cloud-west",
          kind: "tableau-cloud",
          podOrigin: "https://pod.online.tableau.com",
        },
      ],
      firstSite: { deploymentId: "nope", contentUrl: "bad site!" },
      firstOperator: { deploymentId: "cloud-west", siteContentUrl: "s", username: "" },
      extra: true,
    }),
  );
  const paths = (error.fields ?? []).map((f) => `${f.path}=${f.rule}`);
  for (const expected of [
    "bootstrap.deployments.0.kind=one-of:tableau-cloud",
    "bootstrap.deployments.0.podOrigin=https-origin",
    "bootstrap.deployments.0=unknown-field:clientId",
    "bootstrap.firstSite.contentUrl=site-content-url",
    "bootstrap.firstOperator.username=required",
  ])
    assert.ok(paths.includes(expected), `${expected} in ${paths.join(", ")}`);
  assert.ok(
    paths.some((p) => p.startsWith("bootstrap=unknown-field:extra")),
    paths.join(", "),
  );
});

test("V1: bootstrap cross-field rules report after shape passes", () => {
  const error = failure(() =>
    parseBootstrap({
      deployments: [
        {
          id: "a",
          kind: "tableau-cloud",
          podOrigin: "https://pod.online.tableau.com",
        },
        {
          id: "a",
          kind: "tableau-cloud",
          podOrigin: "https://pod.online.tableau.com",
        },
      ],
      firstSite: { deploymentId: "b", contentUrl: "s" },
      firstOperator: { deploymentId: "a", siteContentUrl: "s", username: "u" },
    }),
  );
  const paths = (error.fields ?? []).map((f) => `${f.path}=${f.rule}`);
  assert.deepEqual(paths.sort(), [
    "bootstrap.deployments.1.id=unique",
    "bootstrap.firstSite.deploymentId=known-deployment",
  ]);
});

test("V26: the log redacts secret keys and protected values wherever they appear", () => {
  const lines: string[] = [];
  const log = new Log((line) => lines.push(line));
  const secret = "xoxb-very-secret-token-value";
  log.protect(secret);
  log.info("calling provider", {
    authorization: `Bearer ${secret}`,
    clientSecret: "abc123456",
    nested: { refresh_token: "r-123456", note: `token is ${secret}` },
    url: `https://x.example/?t=${encodeURIComponent(secret)}`,
    error: new Error(`failed with ${secret}`),
  });
  const out = lines.join("\n");
  assert.ok(!out.includes(secret));
  assert.ok(!out.includes("abc123456"));
  assert.ok(!out.includes("r-123456"));
  assert.ok(out.includes("calling provider"));
});
