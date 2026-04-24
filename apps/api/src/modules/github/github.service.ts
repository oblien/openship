/**
 * GitHub service — business logic for repositories, branches, files, and webhooks.
 *
 * All GitHub API interactions go through `githubFetch` from github.auth,
 * keeping this module focused on data transformation and business rules.
 */

import {
  githubFetch,
  getUserStatus,
  getUserInstallations,
  mapAccounts,
  getGitHubAuthMode,
} from "./github.auth";
import { getLocalGhStatus } from "./github.local-auth";
import type {
  GitHubRepository,
  GitHubBranch,
  GitHubFileContent,
  GitHubWebhook,
  MappedRepository,
  MappedAccount,
  RepositoryDetail,
} from "./github.types";
import { env } from "../../config/env";

// ─── Repository mapping ─────────────────────────────────────────────────────

/**
 * Map raw GitHub API repos to a clean, consistent shape.
 */
export function mapRepositories(repos: GitHubRepository[]): MappedRepository[] {
  if (!Array.isArray(repos)) return [];

  return repos.map((r) => ({
    full_name: r.full_name,
    name: r.name,
    owner: r.owner?.login ?? r.full_name?.split("/")?.[0] ?? "",
    description: r.description,
    html_url: r.html_url,
    private: r.private,
    visibility: r.visibility,
    default_branch: r.default_branch,
    language: r.language,
    size: r.size,
    forks: r.forks,
    watchers: r.watchers,
    stars: r.stargazers_count ?? 0,
    license: r.license,
    created_at: r.created_at,
    updated_at: r.updated_at,
    pushed_at: r.pushed_at,
  }));
}

// ─── Repository operations ───────────────────────────────────────────────────

/**
 * Fetch repos for a user/org via personal OAuth token (desktop/self-hosted mode).
 * Works without a GitHub App installation.
 */
export async function listUserOwnedRepos(
  userId: string,
  owner?: string,
): Promise<MappedRepository[]> {
  if (!owner) {
    // User's own repos
    const data = await githubFetch<GitHubRepository[]>({
      userId,
      url: "https://api.github.com/user/repos",
      useUserToken: true,
      params: { per_page: 100, sort: "updated", affiliation: "owner,collaborator,organization_member" },
    });
    return mapRepositories(Array.isArray(data) ? data : []);
  }

  // Org repos
  const data = await githubFetch<GitHubRepository[]>({
    userId,
    url: `https://api.github.com/orgs/${encodeURIComponent(owner)}/repos`,
    useUserToken: true,
    params: { type: "all", per_page: 100 },
  });
  return mapRepositories(Array.isArray(data) ? data : []);
}

/**
 * Fetch repositories visible to the installation.
 */
export async function listInstallationRepos(
  userId: string,
  owner: string,
  installationId?: number,
): Promise<MappedRepository[]> {
  const data = await githubFetch<{ repositories: GitHubRepository[] }>({
    userId,
    url: "https://api.github.com/installation/repositories",
    params: { type: "all", per_page: 100 },
    owner,
    installationId,
  });
  return mapRepositories(data.repositories ?? []);
}

/**
 * Fetch repositories for a specific org.
 */
export async function listOrgRepos(
  userId: string,
  org: string,
): Promise<MappedRepository[]> {
  const data = await githubFetch<GitHubRepository[]>({
    userId,
    url: `https://api.github.com/orgs/${encodeURIComponent(org)}/repos`,
    params: { type: "all", per_page: 100 },
    owner: org,
  });
  return mapRepositories(data);
}

/**
 * Get a single repository, optionally with branches.
 */
export async function getRepository(
  userId: string,
  owner: string,
  repo: string,
  opts: { withBranches?: boolean } = {},
): Promise<RepositoryDetail> {
  const data = await githubFetch<GitHubRepository>({
    userId,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  });

  let branches: GitHubBranch[] | undefined;
  if (opts.withBranches) {
    branches = await listBranches(userId, owner, repo);
  }

  return {
    id: data.id,
    name: data.name,
    full_name: data.full_name,
    owner: data.owner?.login ?? owner,
    private: data.private,
    default_branch: data.default_branch,
    clone_url: data.clone_url,
    ssh_url: data.ssh_url,
    html_url: data.html_url,
    branches,
  };
}

/**
 * Create a new repository (user or org).
 */
export async function createRepository(
  userId: string,
  name: string,
  opts: { description?: string; private?: boolean; owner?: string } = {},
): Promise<GitHubRepository> {
  const url = opts.owner
    ? `https://api.github.com/orgs/${encodeURIComponent(opts.owner)}/repos`
    : "https://api.github.com/user/repos";

  return githubFetch<GitHubRepository>({
    userId,
    url,
    method: "POST",
    owner: opts.owner,
    useUserToken: !opts.owner, // user/repos needs user token
    params: {
      name,
      description: opts.description ?? `Repository created by Openship`,
      private: opts.private ?? false,
    },
  });
}

/**
 * Delete a repository (requires admin permissions).
 */
export async function deleteRepository(
  userId: string,
  owner: string,
  repo: string,
): Promise<void> {
  await githubFetch({
    userId,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    method: "DELETE",
  });
}

// ─── Branches ────────────────────────────────────────────────────────────────

/**
 * List branches for a repository.
 */
export async function listBranches(
  userId: string,
  owner: string,
  repo: string,
): Promise<GitHubBranch[]> {
  return githubFetch<GitHubBranch[]>({
    userId,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
  });
}

/**
 * Get the latest commit on a branch.
 */
export async function getLatestCommit(
  userId: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<{ sha: string; message: string } | null> {
  try {
    const data = await githubFetch<{ sha: string; commit: { message: string } }>({
      userId,
      owner,
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(branch)}`,
    });
    return { sha: data.sha, message: data.commit.message };
  } catch {
    return null;
  }
}

/**
 * Fetch recent commits from a branch via the GitHub API.
 */
export async function getRecentCommits(
  userId: string,
  owner: string,
  repo: string,
  branch: string,
  perPage = 10,
): Promise<Array<{
  sha: string;
  message: string;
  author: string;
  authorAvatar: string;
  date: string;
  url: string;
}>> {
  try {
    const data = await githubFetch<Array<{
      sha: string;
      html_url: string;
      commit: {
        message: string;
        author: { name: string; date: string } | null;
      };
      author: { login: string; avatar_url: string } | null;
    }>>({
      userId,
      owner,
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits`,
      params: { sha: branch, per_page: String(perPage) },
    });

    return data.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      author: c.author?.login ?? c.commit.author?.name ?? "Unknown",
      authorAvatar: c.author?.avatar_url ?? "",
      date: c.commit.author?.date ?? "",
      url: c.html_url,
    }));
  } catch {
    return [];
  }
}

// ─── Files ───────────────────────────────────────────────────────────────────

/**
 * List files in a repository directory.
 */
export async function listFiles(
  userId: string,
  owner: string,
  repo: string,
  opts: { branch?: string; path?: string } = {},
): Promise<GitHubFileContent[]> {
  const filePath = opts.path ?? "";
  return githubFetch<GitHubFileContent[]>({
    userId,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath}`,
    params: opts.branch ? { ref: opts.branch } : undefined,
  });
}

/**
 * Get a single file's content (decoded from base64).
 */
export async function getFileContent(
  userId: string,
  owner: string,
  repo: string,
  file: string,
  opts: { branch?: string; json?: boolean } = {},
): Promise<{
  sha: string;
  size: number;
  content: string;
  download_url: string | null;
}> {
  const data = await githubFetch<GitHubFileContent>({
    userId,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${file}`,
    params: opts.branch ? { ref: opts.branch } : undefined,
  });

  let content = Buffer.from(data.content ?? "", "base64").toString("utf-8");

  if (opts.json) {
    try {
      content = JSON.parse(content);
    } catch {
      /* return raw string if not valid JSON */
    }
  }

  return {
    sha: data.sha,
    size: data.size,
    content: typeof content === "string" ? content : JSON.stringify(content),
    download_url: data.download_url,
  };
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

/**
 * List webhooks for a repository.
 */
export async function listWebhooks(
  userId: string,
  owner: string,
  repo: string,
): Promise<GitHubWebhook[]> {
  return githubFetch<GitHubWebhook[]>({
    userId,
    owner,
    useUserToken: true,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`,
  });
}

/**
 * Create a push webhook for a repository.
 */
export async function createWebhook(
  userId: string,
  owner: string,
  repo: string,
  webhookUrl: string,
  secret?: string,
): Promise<{ hookId: number; events: string[]; active: boolean }> {
  const config: Record<string, unknown> = {
    url: webhookUrl,
    content_type: "json",
  };
  if (secret) config.secret = secret;

  const data = await githubFetch<GitHubWebhook>({
    userId,
    owner,
    useUserToken: true,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`,
    method: "POST",
    params: {
      name: "web",
      active: true,
      events: ["push"],
      config,
    },
  });

  return { hookId: data.id, events: data.events, active: data.active };
}

/**
 * Update a webhook (e.g. toggle active state).
 */
export async function updateWebhook(
  userId: string,
  owner: string,
  repo: string,
  hookId: number,
  patch: { active?: boolean; events?: string[] },
): Promise<{ id: number; active: boolean; events: string[] }> {
  const data = await githubFetch<GitHubWebhook>({
    userId,
    owner,
    useUserToken: true,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks/${hookId}`,
    method: "PATCH",
    params: patch,
  });
  return { id: data.id, active: data.active, events: data.events };
}

/**
 * Delete a webhook from a repository.
 */
export async function deleteWebhook(
  userId: string,
  owner: string,
  repo: string,
  hookId: number,
): Promise<void> {
  await githubFetch({
    userId,
    owner,
    useUserToken: true,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks/${hookId}`,
    method: "DELETE",
  });
}

// ─── Check runs ──────────────────────────────────────────────────────────────

/**
 * Create a GitHub check run (used to report deployment status).
 */
export async function createCheckRun(
  userId: string,
  owner: string,
  repo: string,
  opts: {
    name: string;
    headSha: string;
    status: "queued" | "in_progress" | "completed";
    detailsUrl?: string;
    output?: { title: string; summary: string; text?: string };
  },
): Promise<number | null> {
  try {
    const data = await githubFetch<{ id: number }>({
      userId,
      owner,
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs`,
      method: "POST",
      params: {
        name: opts.name,
        head_sha: opts.headSha,
        status: opts.status,
        started_at: new Date().toISOString(),
        details_url: opts.detailsUrl,
        output: opts.output,
      },
    });
    return data.id;
  } catch {
    return null;
  }
}

/**
 * Update an existing check run (e.g. mark as completed).
 */
export async function updateCheckRun(
  userId: string,
  owner: string,
  repo: string,
  checkRunId: number,
  opts: {
    status: "completed";
    conclusion: "success" | "failure" | "cancelled";
  },
): Promise<void> {
  try {
    await githubFetch({
      userId,
      owner,
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs/${checkRunId}`,
      method: "PATCH",
      params: {
        status: opts.status,
        completed_at: new Date().toISOString(),
        conclusion: opts.conclusion,
      },
    });
  } catch {
    /* best-effort — don't fail the deployment if check update fails */
  }
}

// ─── User organisations ──────────────────────────────────────────────────────

/**
 * Build account list from the GitHub API (non-app modes).
 * Returns the authenticated user + their orgs.
 */
export async function listUserAccounts(
  userId: string,
  status: { login: string; id: number; avatar_url: string },
): Promise<MappedAccount[]> {
  const accounts: MappedAccount[] = [
    { login: status.login, id: status.id, avatar_url: status.avatar_url, type: "User" },
  ];
  try {
    const orgs = await githubFetch<Array<{ login: string; id: number; avatar_url: string }>>({
      userId,
      url: "https://api.github.com/user/orgs",
      useUserToken: true,
    });
    for (const org of orgs) {
      accounts.push({ login: org.login, id: org.id, avatar_url: org.avatar_url, type: "Organization" });
    }
  } catch { /* empty */ }
  return accounts;
}

/**
 * List the user's GitHub organisations via API (non-app modes).
 */
export async function listUserOrgsViaApi(userId: string): Promise<MappedAccount[]> {
  try {
    const orgs = await githubFetch<Array<{ login: string; id: number; avatar_url: string }>>({
      userId,
      url: "https://api.github.com/user/orgs",
      useUserToken: true,
    });
    return orgs.map((o) => ({ login: o.login, id: o.id, avatar_url: o.avatar_url, type: "Organization" }));
  } catch {
    return [];
  }
}

/**
 * List orgs with their repos via API (non-app modes).
 */
export async function listUserOrgsWithReposViaApi(
  userId: string,
): Promise<Array<{ org: MappedAccount; repos: MappedRepository[] }>> {
  const orgs = await listUserOrgsViaApi(userId);
  return Promise.all(
    orgs.map(async (org) => {
      const repos = await listUserOwnedRepos(userId, org.login);
      return { org, repos };
    }),
  );
}

/**
 * List the user's GitHub organisations (app mode — via installations).
 */
export async function listUserOrgs(userId: string): Promise<MappedAccount[]> {
  const installations = await getUserInstallations(userId);
  return mapAccounts(installations.filter((i) => i.account.type === "Organization"));
}

/**
 * List orgs with their repos (mirrors old fetchUserOrgsWithRepos).
 */
export async function listUserOrgsWithRepos(
  userId: string,
): Promise<Array<{ org: MappedAccount; repos: MappedRepository[] }>> {
  const installations = await getUserInstallations(userId);
  const orgInstallations = installations.filter((i) => i.account.type === "Organization");

  return Promise.all(
    orgInstallations.map(async (inst) => {
      const repos = await listOrgRepos(userId, inst.account.login);
      return {
        org: {
          login: inst.account.login,
          id: inst.account.id,
          avatar_url: inst.account.avatar_url,
          type: inst.account.type,
        },
        repos,
      };
    }),
  );
}

/**
 * Get the user's "home" view — status, accounts, and personal repos.
 */
export async function getUserHome(userId: string) {
  const status = await getUserStatus(userId);
  const mode = getGitHubAuthMode();

  // In cli mode, include local gh CLI status
  const localStatus = mode === "cli" ? await getLocalGhStatus() : undefined;

  if (!status.connected) {
    return { status, repos: [] as MappedRepository[], accounts: [] as MappedAccount[], mode, localStatus };
  }

  if (mode !== "app") {
    // Non-app modes: fetch repos via personal token (OAuth, CLI, or static)
    let repos: MappedRepository[] = [];
    try {
      const data = await githubFetch<GitHubRepository[]>({
        userId,
        url: "https://api.github.com/user/repos",
        useUserToken: true,
        params: { per_page: 100, sort: "updated", affiliation: "owner,collaborator,organization_member" },
      });
      repos = mapRepositories(Array.isArray(data) ? data : []);
    } catch { /* empty */ }

    // Build account list from /user + /user/orgs
    const accounts: MappedAccount[] = [
      { login: status.login, id: status.id, avatar_url: status.avatar_url, type: "User" },
    ];
    try {
      const orgs = await githubFetch<Array<{ login: string; id: number; avatar_url: string }>>({
        userId,
        url: "https://api.github.com/user/orgs",
        useUserToken: true,
      });
      for (const org of orgs) {
        accounts.push({ login: org.login, id: org.id, avatar_url: org.avatar_url, type: "Organization" });
      }
    } catch { /* empty */ }

    return { status, repos, accounts, mode, localStatus };
  }

  // App mode: use GitHub App installations
  let accounts: MappedAccount[] = [];
  let repos: MappedRepository[] = [];

  try {
    const installations = await getUserInstallations(userId);
    accounts = mapAccounts(installations);

    if (installations.length > 0) {
      repos = await listInstallationRepos(userId, status.login, installations[0].id);
    }
  } catch (err) {
    // Private key not configured or installation token failed — return empty
    console.warn("[GitHub] Failed to fetch installations/repos:", (err as Error).message);
  }

  return { status, repos, accounts, mode, localStatus };
}

// ─── Webhook strategy ────────────────────────────────────────────────────────

export type WebhookStrategy = "app" | "domain" | "repo" | "none";

/**
 * Determine the base webhook strategy from global config (sync, no user context).
 *
 *  - "app"  → GitHub App handles push events natively (cloud mode).
 *  - "repo" → Create per-repo webhooks (self-hosted with a public URL).
 *  - "none" → Can't receive webhooks (localhost / private IP).
 */
export function getWebhookStrategy(): WebhookStrategy {
  if (getGitHubAuthMode() === "app") return "app";

  // For non-app modes, check if the URL is publicly reachable
  const url = env.BETTER_AUTH_URL;
  if (isLocalUrl(url)) return "none";
  return "repo";
}

/**
 * Resolve the effective webhook strategy for a project + user (async).
 *
 * Priority:
 *   1. "app"    — GitHub App (cloud mode)
 *   2. "domain" — project has a webhookDomain set (direct delivery)
 *   3. "repo"   — BETTER_AUTH_URL is public
 *   4. "none"   — no way to receive webhooks
 */
export async function resolveWebhookStrategy(
  _userId: string,
  project?: { webhookDomain?: string | null },
): Promise<WebhookStrategy> {
  const base = getWebhookStrategy();
  if (base === "app") return "app";

  // Project has a domain configured → direct webhook delivery
  if (project?.webhookDomain) return "domain";

  // Public URL → repo-level webhooks at BETTER_AUTH_URL
  if (base === "repo") return "repo";

  return "none";
}

/**
 * Get the list of available webhook strategies for a user + project.
 * Used by the dashboard to show options to the user.
 */
export async function getAvailableStrategies(
  userId: string,
  project?: { webhookDomain?: string | null },
): Promise<{ current: WebhookStrategy; available: WebhookStrategy[] }> {
  const current = await resolveWebhookStrategy(userId, project);
  const available: WebhookStrategy[] = [];

  if (getGitHubAuthMode() === "app") {
    available.push("app");
    return { current, available };
  }

  // Domain is always available if verified domains exist (handled by UI)
  available.push("domain");

  if (!isLocalUrl(env.BETTER_AUTH_URL)) {
    available.push("repo");
  }

  return { current, available };
}

/** True when the URL points to localhost or a private/unreachable address. */
function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1" ||
      hostname.endsWith(".local") ||
      /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(hostname)
    );
  } catch {
    return true;
  }
}

// ─── Webhook registration ────────────────────────────────────────────────────

/**
 * Register a push webhook on a repo.
 * If creation returns 422 (already exists), finds the existing hook.
 *
 * Callers should check `getWebhookStrategy()` before calling — this will
 * throw if the URL is unreachable (localhost).
 */
export async function registerWebhook(
  userId: string,
  owner: string,
  repo: string,
): Promise<{ hookId: number | null; events: string[] }> {
  const webhookUrl = `${env.BETTER_AUTH_URL}/api/webhooks/github`;

  try {
    const result = await createWebhook(userId, owner, repo, webhookUrl);
    return { hookId: result.hookId, events: result.events };
  } catch (err) {
    /* 422 = webhook already exists — find it */
    if (err instanceof Error && err.message.includes("422")) {
      const existing = await listWebhooks(userId, owner, repo);
      const match = existing.find((h) =>
        h.config?.url?.includes("/api/webhooks/github"),
      );
      return { hookId: match?.id ?? null, events: match?.events ?? [] };
    }
    throw err;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract owner and repo from a GitHub URL.
 */
export function parseRepoUrl(repoUrl: string): { owner: string; repo: string } | null {
  if (!repoUrl) return null;
  const parts = repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "").split("/");
  const owner = parts[0];
  const repo = parts[1]?.replace(/\.git$/, "");
  if (!owner || !repo) return null;
  return { owner, repo };
}
