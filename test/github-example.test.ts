import assert from "node:assert/strict";
import { test } from "node:test";
import { github, type Pull, type Repository } from "../examples/github/github.ts";
import { loadPagesTogether } from "../examples/github/parallel-pages.ts";
import type { CatalogTemplate } from "../src/contracts/operator.ts";
import { RESTORE_COOKIE } from "../src/http/cookies.ts";
import { createService } from "../src/sdk/index.ts";
import { IntakeProvider, intakeHarness, type ProviderRequest } from "./support/intake-providers.ts";

const repo: Repository = { full_name: "sample/emporium", default_branch: "main", private: true };
const pull: Pull = {
  number: 7,
  title: "Add inventory export",
  draft: false,
  body: "Allow users to download a CSV.",
  state: "open",
  merged: false,
  user: { login: "example-author" },
  head: { sha: "example-head-sha", label: "sample:feature/export" },
  base: { ref: "main" },
};

const pullPath = `/repos/${repo.full_name}/pulls/${pull.number}`;
const shaPath = `/repos/${repo.full_name}/commits/${pull.head.sha}`;

test("parallel page loads wait for a pending sibling before propagating a failure", async () => {
  const expired = new Error("Sign in with Tableau to continue");
  const sibling = Promise.withResolvers<void>();
  let reported = false;
  const loading = loadPagesTogether(Promise.reject(expired), sibling.promise);
  const finished = assert
    .rejects(loading, (error) => error === expired)
    .then(() => {
      reported = true;
    });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reported, false);
  sibling.resolve();
  await finished;
});

test("GitHub pagination rejects a link that leaves the GitHub API origin", async () => {
  const api = github(async () =>
    Response.json([], {
      headers: { Link: '<https://outside.example/user/repos?page=2>; rel="next"' },
    }),
  );
  await assert.rejects(api.repositories(), /outside the expected API origin/);
});

test("GitHub catalog and example use sealed personal auth and forward native REST reads and writes", {
  timeout: 20_000,
}, async (t) => {
  const provider = await new IntakeProvider().start();
  t.after(() => provider.close());
  const h = await intakeHarness(provider);
  t.after(() => h.close());
  const token = "synthetic-github-token";
  const catalog = await h.request("/v1/admin/catalog");
  assert.equal(catalog.status, 200);
  const { templates } = (await catalog.json()) as { templates: CatalogTemplate[] };
  const template = templates.find((entry) => entry.id === "github");
  assert.ok(template);
  assert.deepEqual(template.definition.apiHosts, ["https://api.github.com"]);
  assert.equal(template.definition.privateHosts, false);
  await h.create(
    h.definition("github", {
      ...template.definition,
      apiHosts: [provider.origin],
      audience: [h.siteId],
      privateHosts: true,
    }),
  );

  const service = createService({
    origin: h.origin,
    appId: "github-example",
    // Node has no browser cookie jar. Supply the signed fixture's restore cookie to the real API.
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      if (String(input).endsWith("/v1/session/restore")) {
        headers.set("Cookie", `${RESTORE_COOKIE}=${h.app.restoreToken}`);
      }
      return fetch(input, { ...init, headers });
    },
  });
  const api = github((path, init) => service.fetch("github", path, init));
  const before = await service.definition("github");
  assert.equal(before?.ownership, "personal");
  assert.equal(before?.status, "not-connected");
  const connected = await service.setCredential("github", { kind: "token", value: token });
  assert.equal(connected.status, "connected");

  function check(method: string, body?: unknown) {
    return (request: ProviderRequest) => {
      assert.equal(request.method, method);
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      assert.equal(request.headers["tableau-service-authorization"], undefined);
      assert.equal(request.headers.accept, "application/vnd.github+json");
      assert.equal(request.headers["x-github-api-version"], "2026-03-10");
      if (body !== undefined) assert.deepEqual(JSON.parse(request.body.toString()), body);
    };
  }

  provider.expect(
    "/user/repos",
    (req) => {
      check("GET")(req);
      assert.equal(req.url.searchParams.get("sort"), "pushed");
    },
    { json: [repo], headers: { Link: '<https://api.github.com/user/repos?page=2>; rel="next"' } },
  );
  provider.expect(
    "/user/repos",
    (req) => {
      check("GET")(req);
      assert.equal(req.url.searchParams.get("page"), "2");
    },
    { json: [{ ...repo, full_name: "sample/market" }] },
  );
  const repos = await api.repositories();
  assert.deepEqual(repos.items, [repo]);
  assert.equal(repos.next, "/user/repos?page=2");
  assert.deepEqual(
    (await api.repositories(repos.next)).items.map((entry) => entry.full_name),
    ["sample/market"],
  );

  provider.expect(`/repos/${repo.full_name}/branches`, check("GET"), {
    json: [{ name: "feature/export" }],
  });
  assert.deepEqual((await api.branches(repo)).items, [{ name: "feature/export" }]);
  const commit = { sha: pull.head.sha, commit: { message: pull.title, author: null } };
  provider.expect(
    `/repos/${repo.full_name}/commits`,
    (req) => {
      check("GET")(req);
      assert.ok(req.url.search.includes("sha=feature%2Fexport"));
    },
    { json: [commit] },
  );
  assert.deepEqual((await api.commits(repo, "feature/export")).items, [commit]);
  provider.expect(`/repos/${repo.full_name}/pulls`, check("GET"), { json: [pull] });
  assert.equal((await api.pulls(repo, "open")).items[0]?.number, pull.number);
  provider.expect(pullPath, check("GET"), { json: pull });
  const selected = await api.pull(repo, pull.number);
  assert.deepEqual(selected, pull);

  provider.expect(`${shaPath}/check-runs`, check("GET"), {
    status: 403,
    json: { message: "Resource not accessible by personal access token" },
  });
  await assert.rejects(
    api.checks(repo, pull.head.sha),
    /GitHub HTTP 403 - Resource not accessible/,
  );
  provider.expect(`${shaPath}/check-runs`, check("GET"), {
    json: { check_runs: [{ name: "Build", status: "completed", conclusion: "success" }] },
  });
  assert.equal((await api.checks(repo, pull.head.sha)).items[0]?.conclusion, "success");
  provider.expect(`${shaPath}/statuses`, check("GET"), {
    json: [{ context: "Deploy", state: "pending", description: null }],
  });
  assert.equal((await api.statuses(repo, pull.head.sha)).items[0]?.state, "pending");

  await assert.rejects(
    api.review(repo, selected, "REQUEST_CHANGES", "  "),
    /Enter a review comment/,
  );
  provider.expect(
    `${pullPath}/reviews`,
    check("POST", { event: "APPROVE", commit_id: pull.head.sha }),
    { status: 201, json: { state: "APPROVED" } },
  );
  assert.equal((await api.review(repo, selected, "APPROVE", "")).state, "APPROVED");
  provider.expect(
    `${pullPath}/reviews`,
    check("POST", { event: "REQUEST_CHANGES", body: "Add tests", commit_id: pull.head.sha }),
    { status: 201, json: { state: "CHANGES_REQUESTED" } },
  );
  assert.equal(
    (await api.review(repo, selected, "REQUEST_CHANGES", "Add tests")).state,
    "CHANGES_REQUESTED",
  );
  provider.expect(pullPath, check("PATCH", { state: "closed" }), {
    json: { ...pull, state: "closed" },
  });
  assert.equal((await api.close(repo, selected)).state, "closed");

  const merge = check("PUT", { sha: pull.head.sha, merge_method: "squash" });
  provider.expect(`${pullPath}/merge`, merge, { status: 409, json: { message: "Head moved" } });
  await assert.rejects(api.merge(repo, selected, "squash"), /GitHub HTTP 409 - Head moved/);
  provider.expect(`${pullPath}/merge`, merge, { json: { merged: false, message: "Blocked" } });
  await assert.rejects(api.merge(repo, selected, "squash"), /did not merge.*Blocked/);
  provider.expect(`${pullPath}/merge`, merge, {
    json: { merged: true, sha: "merge-sha", message: "Merged" },
  });
  assert.equal((await api.merge(repo, selected, "squash")).sha, "merge-sha");
  provider.assertComplete();
  await h.assertSafe([token], [JSON.stringify(connected), JSON.stringify(await h.view("github"))]);
});
