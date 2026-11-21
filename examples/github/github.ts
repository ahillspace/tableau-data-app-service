const apiOrigin = "https://api.github.com";
const pageSize = 30;

export type NativeFetch = (path: string, init?: RequestInit) => Promise<Response>;
export type Page<T> = { items: T[]; next: string | undefined };
export type Repository = { full_name: string; default_branch: string; private: boolean };
export type Branch = { name: string };
export type Commit = {
  sha: string;
  commit: { message: string; author: { name: string; date: string } | null };
};
export type PullSummary = { number: number; title: string; draft: boolean };
export type Pull = PullSummary & {
  body: string | null;
  state: "open" | "closed";
  merged: boolean;
  user: { login: string } | null;
  head: { sha: string; label: string };
  base: { ref: string };
};
export type CheckRun = { name: string; status: string; conclusion: string | null };
export type CommitStatus = { context: string; state: string; description: string | null };
export type MergeMethod = "merge" | "squash" | "rebase";
export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES";

function nextPage(link: string | null): string | undefined {
  const match = link?.match(/<([^>]+)>\s*;\s*rel="next"/);
  if (!match?.[1]) return undefined;
  const url = new URL(match[1], apiOrigin);
  if (url.origin !== apiOrigin || url.username || url.password || url.pathname.startsWith("//")) {
    throw new Error("GitHub returned a pagination link outside the expected API origin.");
  }
  return `${url.pathname}${url.search}`;
}

const repoPath = (repo: Repository) =>
  `/repos/${repo.full_name.split("/").map(encodeURIComponent).join("/")}`;
const pullPath = (repo: Repository, number: number) => `${repoPath(repo)}/pulls/${number}`;

export function github(fetch: NativeFetch) {
  async function request<T>(path: string, method = "GET", body?: unknown) {
    const headers = new Headers({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
    });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const response = await fetch(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const payload = await response.text();
      let detail = payload;
      try {
        const error = JSON.parse(payload);
        detail = typeof error?.message === "string" ? error.message : payload;
        if (Array.isArray(error?.errors)) {
          detail += ` ${JSON.stringify(error.errors)}`;
        }
      } catch {
        // GitHub may return a non-JSON response.
      }
      throw new Error(
        `GitHub HTTP ${response.status}${detail ? ` - ${detail.slice(0, 600)}` : ""}`,
      );
    }
    return { data: (await response.json()) as T, response };
  }

  async function page<T, Data = T[]>(
    path: string,
    items: (response: Data) => T[] = (data) => data as T[],
  ): Promise<Page<T>> {
    const { data, response } = await request<Data>(path);
    return { items: items(data), next: nextPage(response.headers.get("Link")) };
  }

  return {
    repositories: (next?: string) =>
      page<Repository>(next ?? `/user/repos?sort=pushed&per_page=${pageSize}`),
    branches: (repo: Repository, next?: string) =>
      page<Branch>(next ?? `${repoPath(repo)}/branches?per_page=${pageSize}`),
    commits: (repo: Repository, branch: string, next?: string) =>
      page<Commit>(
        next ?? `${repoPath(repo)}/commits?sha=${encodeURIComponent(branch)}&per_page=${pageSize}`,
      ),
    pulls: (repo: Repository, state: string, next?: string) =>
      page<PullSummary>(
        next ?? `${repoPath(repo)}/pulls?state=${encodeURIComponent(state)}&per_page=${pageSize}`,
      ),
    pull: async (repo: Repository, number: number) =>
      (await request<Pull>(pullPath(repo, number))).data,
    checks: (repo: Repository, sha: string, next?: string) =>
      page<CheckRun, { check_runs: CheckRun[] }>(
        next ??
          `${repoPath(repo)}/commits/${encodeURIComponent(sha)}/check-runs?per_page=${pageSize}`,
        (data) => data.check_runs,
      ),
    statuses: (repo: Repository, sha: string, next?: string) =>
      page<CommitStatus>(
        next ??
          `${repoPath(repo)}/commits/${encodeURIComponent(sha)}/statuses?per_page=${pageSize}`,
      ),
    review: async (repo: Repository, pull: Pull, event: ReviewEvent, body: string) => {
      if (event === "REQUEST_CHANGES" && !body.trim())
        throw new Error("Enter a review comment to request changes.");
      return (
        await request<{ state: string }>(`${pullPath(repo, pull.number)}/reviews`, "POST", {
          commit_id: pull.head.sha,
          event,
          ...(body.trim() ? { body: body.trim() } : {}),
        })
      ).data;
    },
    close: async (repo: Repository, pull: Pull) =>
      (await request<Pull>(pullPath(repo, pull.number), "PATCH", { state: "closed" })).data,
    merge: async (repo: Repository, pull: Pull, method: MergeMethod) => {
      const { data } = await request<{ merged: boolean; sha: string; message: string }>(
        `${pullPath(repo, pull.number)}/merge`,
        "PUT",
        { sha: pull.head.sha, merge_method: method },
      );
      if (!data.merged) throw new Error(`GitHub did not merge the pull request - ${data.message}`);
      return data;
    },
  };
}
