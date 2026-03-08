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
  isCloudMode,
} from "./github.auth";
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
): Promise<{ hookId: number; events: string[]; active: boolean }> {
  const data = await githubFetch<GitHubWebhook>({
    userId,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`,
    method: "POST",
    params: {
      name: "web",
      active: true,
      events: ["push"],
      config: {
        url: webhookUrl,
        content_type: "json",
      },
    },
  });

  return { hookId: data.id, events: data.events, active: data.active };
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
 * List the user's GitHub organisations (as mapped accounts).
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
  const cloud = isCloudMode();

  if (!status.connected) {
    return { status, repos: [] as MappedRepository[], accounts: [] as MappedAccount[], mode: cloud ? "cloud" : "desktop" };
  }

  if (!cloud) {
    // Desktop/self-hosted: fetch repos via user's personal OAuth token
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

    return { status, repos, accounts, mode: "desktop" as const };
  }

  // Cloud mode: use GitHub App installations
  const installations = await getUserInstallations(userId);
  const accounts = mapAccounts(installations);

  let repos: MappedRepository[] = [];
  if (installations.length > 0) {
    repos = await listInstallationRepos(userId, status.login, installations[0].id);
  }

  return { status, repos, accounts, mode: "cloud" as const };
}

// ─── Webhook registration ────────────────────────────────────────────────────

/**
 * Register a push webhook on a repo.
 * If creation returns 422 (already exists), finds the existing hook.
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
