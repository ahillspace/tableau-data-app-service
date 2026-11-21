import { createService, ServiceError } from "../../src/sdk/index.ts";
import {
  github,
  type MergeMethod,
  type Page,
  type Pull,
  type PullSummary,
  type Repository,
} from "./github.ts";

declare const EXAMPLE_CONFIGURATION: { serviceOrigin: string; appId: string; definitionId: string };
const config = EXAMPLE_CONFIGURATION;
const service = createService({ origin: config.serviceOrigin, appId: config.appId });
const api = github((path, init) => service.fetch(config.definitionId, path, init));
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const identity = element("identity");
const status = element("status");
const signIn = element<HTMLButtonElement>("sign-in");
const reload = element<HTMLButtonElement>("reload");
const workspace = element<HTMLFieldSetElement>("workspace");
const repoContent = element("repo-content");
const repoSelect = element<HTMLSelectElement>("repository");
const branchSelect = element<HTMLSelectElement>("branch");
const pullSelect = element<HTMLSelectElement>("pull");
const pullState = element<HTMLSelectElement>("pull-state");
const tokenForm = element<HTMLFormElement>("token");
const tokenValue = element<HTMLInputElement>("token-value");
const disconnect = element<HTMLButtonElement>("disconnect");
const detail = element("detail");
const reviewBody = element<HTMLTextAreaElement>("review-body");
const confirmation = element<HTMLDialogElement>("confirm");
let repository: Repository | undefined;
let activePull: Pull | undefined;
let confirmAction: (() => Promise<void>) | undefined;
let busy = false;

function say(message: string) {
  status.textContent = message;
}

function signedOut() {
  identity.textContent = "Sign in with Tableau to start browsing.";
  signIn.hidden = false;
  reload.hidden = tokenForm.hidden = workspace.hidden = true;
}

async function run(action: () => Promise<void>) {
  if (busy) return;
  busy = workspace.disabled = reload.disabled = signIn.disabled = true;
  for (const control of tokenForm.querySelectorAll("input, button")) {
    (control as HTMLInputElement | HTMLButtonElement).disabled = true;
  }
  say("Working…");
  try {
    await action();
    if (status.textContent === "Working…") say("");
  } catch (error) {
    if (error instanceof ServiceError && error.code === "sign-in-required") signedOut();
    const message = error instanceof Error ? error.message : String(error);
    say(status.textContent === "Working…" ? message : `${status.textContent} ${message}`);
  } finally {
    busy = workspace.disabled = reload.disabled = signIn.disabled = false;
    for (const control of tokenForm.querySelectorAll("input, button")) {
      (control as HTMLInputElement | HTMLButtonElement).disabled = false;
    }
  }
}

function row(label: string, meta?: string) {
  const item = document.createElement("li");
  item.textContent = label;
  if (meta) {
    const subtitle = document.createElement("small");
    subtitle.textContent = meta;
    item.append(subtitle);
  }
  return item;
}

function pager<T>(
  target: HTMLElement,
  moreId: string,
  load: (next?: string) => Promise<Page<T>>,
  render: (item: T) => HTMLElement,
  empty: string,
) {
  const more = element<HTMLButtonElement>(moreId);
  let next: string | undefined;
  const notice = (message: string) =>
    target instanceof HTMLSelectElement ? new Option(message, "") : row(message);
  async function read(append: boolean) {
    if (!append) {
      target.replaceChildren();
      more.hidden = true;
    }
    try {
      const page = await load(append ? next : undefined);
      if (!append) {
        if (!page.items.length) target.append(notice(empty));
        else if (target instanceof HTMLSelectElement) target.append(notice("Choose…"));
      }
      target.append(...page.items.map(render));
      next = page.next;
      more.hidden = !next;
    } catch (error) {
      if (error instanceof ServiceError && error.code === "sign-in-required") throw error;
      if (append) throw error;
      target.replaceChildren(notice(error instanceof Error ? error.message : String(error)));
    }
  }
  more.onclick = () => void run(() => read(true));
  return () => read(false);
}

const repositories = new Map<string, Repository>();
const loadRepos = pager(
  repoSelect,
  "more-repos",
  api.repositories,
  (repo) => {
    repositories.set(repo.full_name, repo);
    return new Option(`${repo.full_name}${repo.private ? " (private)" : ""}`, repo.full_name);
  },
  "No accessible repositories",
);
const loadBranches = pager(
  branchSelect,
  "more-branches",
  (next) => api.branches(repository!, next),
  (branch) => new Option(branch.name, branch.name),
  "No branches",
);
const loadCommits = pager(
  element("commits"),
  "more-commits",
  (next) => api.commits(repository!, branchSelect.value, next),
  (commit) =>
    row(
      commit.commit.message.split("\n")[0] || "No commit message",
      [commit.sha.slice(0, 12), commit.commit.author?.name, commit.commit.author?.date.slice(0, 10)]
        .filter(Boolean)
        .join(" · "),
    ),
  "No commits",
);
const loadPulls = pager(
  pullSelect,
  "more-pulls",
  (next) => api.pulls(repository!, pullState.value, next),
  (pull: PullSummary) =>
    new Option(`#${pull.number} ${pull.title}${pull.draft ? " (draft)" : ""}`, String(pull.number)),
  "No pull requests",
);
const loadChecks = pager(
  element("checks"),
  "more-checks",
  (next) => api.checks(repository!, activePull!.head.sha, next),
  (check) => row(check.name, check.conclusion ?? check.status),
  "GitHub returned no check runs for this head commit.",
);
const loadStatuses = pager(
  element("statuses"),
  "more-statuses",
  (next) => api.statuses(repository!, activePull!.head.sha, next),
  (commitStatus) =>
    row(`${commitStatus.context} · ${commitStatus.state}`, commitStatus.description ?? undefined),
  "GitHub returned no commit statuses for this head commit.",
);

async function refreshConnection() {
  signIn.hidden = true;
  reload.hidden = false;
  workspace.hidden = repoContent.hidden = tokenForm.hidden = true;
  repositories.clear();
  const definition = await service.definition(config.definitionId);
  identity.textContent = `Signed in to Tableau as ${service.session?.userName ?? "viewer"}.`;
  if (!definition) {
    say(`GitHub definition “${config.definitionId}” is unavailable to your Tableau site.`);
    return;
  }
  const personalToken = definition.ownership === "personal" && definition.setup.credential;
  const connected = definition.status === "connected";
  identity.textContent += ` GitHub ${definition.ownership} connection: ${definition.status.replaceAll("-", " ")}.`;
  tokenForm.hidden = !personalToken;
  disconnect.hidden = definition.status === "not-connected";
  if (!connected) {
    say(
      personalToken
        ? "Enter a GitHub token to continue."
        : "Ask your operator to connect this definition.",
    );
    return;
  }
  workspace.hidden = false;
  await loadRepos();
}

function resetPull() {
  activePull = undefined;
  detail.hidden = true;
  reviewBody.value = "";
}

async function showPull() {
  resetPull();
  if (!pullSelect.value) return;
  activePull = await api.pull(repository!, Number(pullSelect.value));
  element("pull-title").textContent = `#${activePull.number} ${activePull.title}`;
  const state = activePull.merged
    ? "merged"
    : activePull.draft && activePull.state === "open"
      ? "draft"
      : activePull.state;
  element("pull-meta").textContent =
    `${state} · ${activePull.user?.login ?? "Unknown author"} · ${activePull.head.label} → ${activePull.base.ref} · ${activePull.head.sha.slice(0, 12)}`;
  const repoPath = repository!.full_name.split("/").map(encodeURIComponent).join("/");
  element<HTMLAnchorElement>("pull-link").href =
    `https://github.com/${repoPath}/pull/${activePull.number}`;
  element("pull-body").textContent = activePull.body ?? "";
  element("actions").hidden = activePull.state !== "open";
  element<HTMLButtonElement>("merge").disabled = activePull.draft;
  detail.hidden = false;
  await Promise.all([loadChecks(), loadStatuses()]);
}

async function showCommits() {
  if (branchSelect.value) await loadCommits();
  else {
    element("commits").replaceChildren(row("Choose a branch to see commits."));
    element("more-commits").hidden = true;
  }
}

repoSelect.onchange = () =>
  void run(async () => {
    repository = repositories.get(repoSelect.value);
    repoContent.hidden = !repository;
    resetPull();
    if (!repository) return;
    pullState.value = "open";
    await Promise.all([loadBranches(), loadPulls()]);
    if (
      Array.from(branchSelect.options).some((option) => option.value === repository?.default_branch)
    ) {
      branchSelect.value = repository.default_branch;
    }
    await showCommits();
  });
branchSelect.onchange = () => void run(showCommits);
pullSelect.onchange = () => void run(showPull);
element("refresh-pull").onclick = () => void run(showPull);
pullState.onchange = () =>
  void run(async () => {
    resetPull();
    await loadPulls();
  });

function confirm(label: string, action: (repo: Repository, pull: Pull) => Promise<string>) {
  if (busy || !repository || !activePull) return;
  const repo = repository;
  const pull = activePull;
  confirmation.returnValue = "";
  element("confirm-title").textContent = label;
  element("confirm-target").textContent = `${repo.full_name} #${pull.number} · ${pull.title}`;
  element("confirm-action").textContent = label;
  confirmAction = async () => {
    say(await action(repo, pull));
    await showPull();
  };
  confirmation.showModal();
}
confirmation.onclose = () => {
  const action = confirmAction;
  confirmAction = undefined;
  if (action && confirmation.returnValue === "proceed") void run(action);
};
element<HTMLButtonElement>("approve").onclick = () => {
  const body = reviewBody.value;
  confirm(
    "Approve",
    async (repo, pull) =>
      `GitHub review: ${(await api.review(repo, pull, "APPROVE", body)).state}.`,
  );
};
element<HTMLButtonElement>("request-changes").onclick = () => {
  const body = reviewBody.value;
  if (!body.trim()) {
    say("Enter a review comment to request changes.");
    reviewBody.focus();
    return;
  }
  confirm(
    "Request changes",
    async (repo, pull) =>
      `GitHub review: ${(await api.review(repo, pull, "REQUEST_CHANGES", body)).state}.`,
  );
};
element<HTMLButtonElement>("close").onclick = () =>
  confirm(
    "Close pull request",
    async (repo, pull) => `GitHub pull request state: ${(await api.close(repo, pull)).state}.`,
  );
element<HTMLButtonElement>("merge").onclick = () => {
  const method = element<HTMLSelectElement>("merge-method").value as MergeMethod;
  confirm(`Merge pull request (${method})`, async (repo, pull) => {
    const result = await api.merge(repo, pull, method);
    return `${result.message} (${result.sha.slice(0, 12)}).`;
  });
};

signIn.onclick = () =>
  void run(async () => {
    await service.signIn();
    await refreshConnection();
  });
reload.onclick = () => void run(refreshConnection);
tokenForm.onsubmit = (event) => {
  event.preventDefault();
  const token = tokenValue.value.trim();
  tokenValue.value = "";
  if (!token) return;
  void run(async () => {
    await service.setCredential(config.definitionId, { kind: "token", value: token });
    await refreshConnection();
  });
};
disconnect.onclick = () =>
  void run(async () => {
    await service.disconnect(config.definitionId);
    await refreshConnection();
  });
void run(async () => {
  if (await service.restore()) await refreshConnection();
  else signedOut();
});
