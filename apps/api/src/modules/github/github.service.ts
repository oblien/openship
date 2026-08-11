/**
 * GitHub service - business logic for repositories, branches, files, and webhooks.
 *
 * All GitHub API interactions go through `githubFetch` from github.auth,
 * keeping this module focused on data transformation and business rules.
 */

import { randomBytes } from "crypto";
import {
  githubFetch,
  getGitHubAuthMode,
} from "./github.auth";
import { ghFetch } from "./github.http";
import { mapRepositories } from "./sources/mappers";
import { isIgnoredRepoPath } from "../../lib/project-root-detector";
import type { RequestContext } from "../../lib/request-context";
import { buildBackgroundContext } from "../../lib/request-context";
import { resolveOrgOwner } from "../../lib/org-actor";
import { safeErrorMessage } from "@repo/core";
import { repos as dbRepos } from "@repo/db";
import { encrypt, decrypt } from "../../lib/encryption";
import type {
  GitHubRepository,
  GitHubBranch,
  GitHubFileContent,
  GitHubTreeResponse,
  GitHubWebhook,
  GitHubConnectionState,
  MappedRepository,
  MappedAccount,
  RepositoryDetail,
} from "./github.types";
import { env } from "../../config/env";
import { resolveApiPublicUrl, sharedWebhookUrl, domainWebhookUrl } from "../../lib/public-url";

export const GITHUB_DEPLOY_WEBHOOK_EVENTS = ["push"] as const;
const MAX_FALLBACK_TREE_ENTRIES = 5000;

/**
 * Length in bytes of a per-project webhook signing secret. 32 raw bytes
 * (64 hex chars) is well over GitHub's documented minimum and matches
 * the entropy of the existing env.GITHUB_WEBHOOK_SECRET we generate
 * elsewhere. Keep this exported so the rotate helper and any future
 * callers don't redefine it.
 */
export const WEBHOOK_SECRET_BYTES = 32;

/**
 * OAuth scopes that strictly exceed Openship's needs and should warn a
 * user when present on a saved PAT. These are the broad, account- or
 * org-administrative scopes; possessing them does not break Openship,
 * but the dashboard's PAT save handler should surface a clear warning
 * so the user understands they handed us more access than necessary.
 *
 * Source: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
 */
export const PAT_SCOPE_WARN_PATTERNS: readonly RegExp[] = [
  /^admin:/i,        // admin:org, admin:repo_hook, admin:public_key, …
  /^delete_repo$/i,
  /^write:packages$/i,
  /^write:org$/i,
];

/**
 * Scopes that are REQUIRED — at least one of these MUST be present on a
 * saved PAT. `repo` grants full private-repo read/write; `public_repo`
 * is the public-only subset. Without either we cannot clone or list any
 * non-public repo, so the dashboard's PAT save handler should hard-fail.
 */
export const PAT_SCOPE_REQUIRED: readonly string[] = ["repo", "public_repo"];

/**
 * Result of `inspectPatScope`.
 *
 *   - `scopes` is the validated list of OAuth scopes returned by GitHub
 *     (from the `x-oauth-scopes` response header). Empty when the token
 *     is a fine-grained PAT that doesn't expose classic scopes.
 *   - `user` is the GitHub login the token belongs to — useful for
 *     attribution and downstream "this PAT belongs to @x" UX.
 */
export interface PatScopeReport {
  scopes: string[];
  user: string;
}

/**
 * HIGH #10 — inspect a PAT before we accept and store it. Calls
 * `GET /user` with the proposed token and reads `x-oauth-scopes` from
 * the response header (the canonical place GitHub publishes the scope
 * set of a classic OAuth/PAT token; absent or empty for fine-grained
 * PATs, where scope is set via the repo permission model instead).
 *
 * Throws on any non-2xx — callers should map that to a clean "invalid
 * token" response. The returned `scopes` array is whitespace-split and
 * lowercased; the controller decides whether to:
 *   - REJECT outright (missing every PAT_SCOPE_REQUIRED entry),
 *   - WARN (any PAT_SCOPE_WARN_PATTERNS match), or
 *   - persist alongside `user_settings.patScope` for later re-validation.
 *
 * Lives in github.service.ts (not in lib/) because PAT inspection is
 * GitHub-specific and the constants above belong with it.
 */
export async function inspectPatScope(token: string): Promise<PatScopeReport> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Could not validate PAT (GitHub returned ${res.status}). ${body.slice(0, 200)}`,
    );
  }
  const scopeHeader = res.headers.get("x-oauth-scopes") ?? "";
  const scopes = scopeHeader
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const json = (await res.json()) as { login?: string };
  return { scopes, user: json.login ?? "" };
}

/**
 * Convenience classifier for the inspectPatScope report. Centralizes
 * the policy so callers don't reimplement the rules independently.
 *
 * Returns:
 *   - `{ ok: false, reason }`  — token lacks every required scope; the
 *     caller MUST refuse to save it.
 *   - `{ ok: true, warning }`  — token includes a broader-than-needed
 *     scope; the caller SHOULD surface this back in the response body.
 *   - `{ ok: true }`           — token is fine.
 */
export function classifyPatScope(
  report: PatScopeReport,
):
  | { ok: false; reason: string }
  | { ok: true; warning?: string } {
  const scopeSet = new Set(report.scopes);

  // Fine-grained PATs report no classic scopes — pass without warning.
  // The GitHub API still gates each request by the repo permission grid,
  // so the token can't escalate beyond what the user explicitly granted.
  if (report.scopes.length === 0) return { ok: true };

  if (!PAT_SCOPE_REQUIRED.some((s) => scopeSet.has(s))) {
    return {
      ok: false,
      reason: `PAT is missing required scope (need one of: ${PAT_SCOPE_REQUIRED.join(", ")}). Got: ${report.scopes.join(", ") || "none"}.`,
    };
  }

  const broad = report.scopes.filter((s) =>
    PAT_SCOPE_WARN_PATTERNS.some((re) => re.test(s)),
  );
  if (broad.length > 0) {
    return {
      ok: true,
      warning: `PAT has broader scope than needed: ${broad.join(", ")}. Consider regenerating with only \`repo\` (or \`public_repo\`).`,
    };
  }
  return { ok: true };
}

async function listRepositoryTreeViaContents(
  ctx: RequestContext,
  owner: string,
  repo: string,
  opts: { branch?: string } = {},
): Promise<Array<{ path: string; type: "file" | "dir" }>> {
  const tree: Array<{ path: string; type: "file" | "dir" }> = [];
  const visited = new Set<string>();
  const queue = [""];

  while (queue.length > 0) {
    const currentPath = queue.shift() ?? "";
    if (visited.has(currentPath) || isIgnoredRepoPath(currentPath)) {
      continue;
    }

    visited.add(currentPath);
    const entries = await listFiles(ctx, owner, repo, {
      ...opts,
      ...(currentPath ? { path: currentPath } : {}),
    }).catch(() => [] as GitHubFileContent[]);

    for (const entry of entries) {
      const entryType: "file" | "dir" = entry.type === "dir" ? "dir" : "file";
      tree.push({
        path: entry.path,
        type: entryType,
      });

      if (tree.length >= MAX_FALLBACK_TREE_ENTRIES) {
        return tree;
      }

      if (entry.type === "dir" && !isIgnoredRepoPath(entry.path)) {
        queue.push(entry.path);
      }
    }
  }

  return tree;
}

// ─── Repository mapping ─────────────────────────────────────────────────────

/**
 * Map raw GitHub API repos to a clean, consistent shape.
 */
// Pure mappers live in ./sources/mappers (so source adapters can reuse them
// without importing this heavier module). Re-exported here for back-compat.
export { mapRepositories };

// ─── Repository operations ───────────────────────────────────────────────────

/**
 * Fetch repos for a user/org via personal OAuth token (desktop/self-hosted mode).
 * Works without a GitHub App installation.
 */
export async function listUserOwnedRepos(
  ctx: RequestContext,
  owner?: string,
): Promise<MappedRepository[]> {
  if (!owner) {
    // User's own repos
    const data = await githubFetch<GitHubRepository[]>({
      ctx,
      url: "https://api.github.com/user/repos",
      params: { per_page: 100, sort: "updated", affiliation: "owner,collaborator,organization_member" },
    });
    return mapRepositories(Array.isArray(data) ? data : []);
  }

  // Org repos
  const data = await githubFetch<GitHubRepository[]>({
    ctx,
    url: `https://api.github.com/orgs/${encodeURIComponent(owner)}/repos`,
    params: { type: "all", per_page: 100 },
  });
  return mapRepositories(Array.isArray(data) ? data : []);
}

/**
 * App-installation + per-owner gh-CLI listing, the listing-source resolver,
 * and the listReposForOwner entry point have MOVED into the GitHubSource
 * adapter (./sources): GitHubAppSource owns the installation listing,
 * GhCliSource owns the gh listing, and LocalGitHubSource (the merge) picks
 * gh-first. Controllers call createGitHubSource(ctx).listReposForOwner(owner)
 * directly. listUserOwnedRepos (above) stays — the merge's user-token fallback
 * reuses it.
 */

/**
 * The branch to deploy: the caller's explicit branch (trimmed) when given, else
 * the repo's GitHub default branch. Single home for the "branch-or-default"
 * idiom shared by linkProjectRepo, createProjectEnvironment, and the git-info
 * surface. Callers own any further fallback (e.g. an env slug or "main").
 */
export async function resolveDefaultBranch(
  ctx: RequestContext,
  owner: string,
  repo: string,
  explicit?: string | null,
): Promise<string> {
  const chosen = explicit?.trim();
  if (chosen) return chosen;
  return (await getRepository(ctx, owner, repo)).default_branch;
}

/**
 * Get a single repository, optionally with branches.
 */
export async function getRepository(
  ctx: RequestContext,
  owner: string,
  repo: string,
  opts: { withBranches?: boolean } = {},
): Promise<RepositoryDetail> {
  const data = await githubFetch<GitHubRepository>({
    ctx,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  });

  let branches: GitHubBranch[] | undefined;
  if (opts.withBranches) {
    branches = await listBranches(ctx, owner, repo);
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
  ctx: RequestContext,
  name: string,
  opts: { description?: string; private?: boolean; owner?: string; } = {},
): Promise<GitHubRepository> {
  const url = opts.owner
    ? `https://api.github.com/orgs/${encodeURIComponent(opts.owner)}/repos`
    : "https://api.github.com/user/repos";

  return githubFetch<GitHubRepository>({
    ctx,
    url,
    method: "POST",
    owner: opts.owner,
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
  ctx: RequestContext,
  owner: string,
  repo: string
): Promise<void> {
  await githubFetch({
    ctx,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    method: "DELETE",
  });
}

// ─── Deploy keys ───────────────────────────────────────────────────────────────

/**
 * Register a read-only GitHub deploy key on a repo (`POST /repos/{o}/{r}/keys`).
 * Requires repo Administration on the resolved token — callers surface a 403 as
 * "grant the App Administration permission or use a repo-admin PAT". Returns the
 * GitHub key id (stored for later revocation).
 */
export async function createDeployKey(
  ctx: RequestContext,
  owner: string,
  repo: string,
  title: string,
  publicKey: string,
  readOnly = true,
): Promise<{ id: number }> {
  return githubFetch<{ id: number }>({
    ctx,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/keys`,
    method: "POST",
    params: { title, key: publicKey, read_only: readOnly },
  });
}

/** Delete a deploy key by its GitHub id (`DELETE /repos/{o}/{r}/keys/{id}`). */
export async function revokeDeployKey(
  ctx: RequestContext,
  owner: string,
  repo: string,
  keyId: number,
): Promise<void> {
  await githubFetch({
    ctx,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/keys/${keyId}`,
    method: "DELETE",
  });
}

// ─── Branches ────────────────────────────────────────────────────────────────

/**
 * List branches for a repository.
 */
export async function listBranches(
  ctx: RequestContext,
  owner: string,
  repo: string
): Promise<GitHubBranch[]> {
  return githubFetch<GitHubBranch[]>({
    ctx,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
    params: { per_page: 100 },
  });
}

/**
 * Get the latest commit on a branch.
 */
export async function getLatestCommit(
  ctx: RequestContext,
  owner: string,
  repo: string,
  branch: string,
): Promise<{ sha: string; message: string } | null> {
  try {
    const data = await githubFetch<{ sha: string; commit: { message: string } }>({
      ctx,
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
  ctx: RequestContext,
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
      ctx,
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

/**
 * Compare two commits and return the unioned list of changed file paths.
 *
 * Webhook callers fall back to this when a push event lists exactly 20
 * commits (GitHub truncates `commits[]` to 20 per push, so anything ≥ 20
 * may have omitted some) and they need the FULL changed-files set for
 * smart per-service routing.
 *
 * Returns `null` on any API error so callers can degrade to the truncated
 * commits[] list rather than failing the deploy.
 */
export async function compareCommits(
  ctx: RequestContext,
  owner: string,
  repo: string,
  base: string,
  head: string
): Promise<{ files: string[] } | null> {
  try {
    const data = await githubFetch<{
      files?: Array<{ filename: string; previous_filename?: string }>;
    }>({
      ctx,
      owner,
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    });
    const out = new Set<string>();
    for (const f of data.files ?? []) {
      if (f.filename) out.add(f.filename);
      if (f.previous_filename) out.add(f.previous_filename);
    }
    return { files: Array.from(out) };
  } catch {
    return null;
  }
}

// ─── Files ───────────────────────────────────────────────────────────────────

/**
 * List files in a repository directory.
 */
export async function listFiles(
  ctx: RequestContext,
  owner: string,
  repo: string,
  opts: { branch?: string; path?: string; } = {},
): Promise<GitHubFileContent[]> {
  const filePath = opts.path ?? "";
  return githubFetch<GitHubFileContent[]>({
    ctx,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath}`,
    params: opts.branch ? { ref: opts.branch } : undefined,
  });
}

/**
 * List the full repository tree recursively.
 */
export async function listRepositoryTree(
  ctx: RequestContext,
  owner: string,
  repo: string,
  opts: { branch?: string } = {},
): Promise<Array<{ path: string; type: "file" | "dir" }>> {
  const ref = opts.branch?.trim() || "HEAD";
  const data = await githubFetch<GitHubTreeResponse>({
    ctx,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}`,
    params: { recursive: 1 },
  });

  const tree: Array<{ path: string; type: "file" | "dir" }> = (data.tree ?? [])
    .filter((entry) => entry.type === "blob" || entry.type === "tree")
    .map((entry) => ({
      path: entry.path,
      type: entry.type === "tree" ? "dir" : "file",
    }));

  if (!data.truncated) {
    return tree;
  }

  const fallbackTree = await listRepositoryTreeViaContents(ctx, owner, repo, opts).catch(() => tree);
  return fallbackTree.length > 0 ? fallbackTree : tree;
}

/**
 * Get a single file's content (decoded from base64).
 */
export async function getFileContent(
  ctx: RequestContext,
  owner: string,
  repo: string,
  file: string,
  opts: { branch?: string; json?: boolean; } = {},
): Promise<{
  sha: string;
  size: number;
  content: string;
  download_url: string | null;
}> {
  const data = await githubFetch<GitHubFileContent>({
    ctx,
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
  ctx: RequestContext,
  owner: string,
  repo: string
): Promise<GitHubWebhook[]> {
  return githubFetch<GitHubWebhook[]>({
    ctx,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`,
  });
}

function normalizeWebhookUrl(url?: string | null): string {
  return (url ?? "").replace(/\/+$/, "");
}

/**
 * Create a deploy webhook for a repository.
 */
export async function createWebhook(
  ctx: RequestContext,
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
    ctx,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`,
    method: "POST",
    params: {
      name: "web",
      active: true,
      events: [...GITHUB_DEPLOY_WEBHOOK_EVENTS],
      config,
    },
  });

  return { hookId: data.id, events: data.events, active: data.active };
}

/**
 * Update a webhook (e.g. toggle active state).
 */
export async function updateWebhook(
  ctx: RequestContext,
  owner: string,
  repo: string,
  hookId: number,
  patch: {
    active?: boolean;
    events?: string[];
    config?: Record<string, unknown>;
  },
): Promise<{ id: number; active: boolean; events: string[] }> {
  const data = await githubFetch<GitHubWebhook>({
    ctx,
    owner,
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
  ctx: RequestContext,
  owner: string,
  repo: string,
  hookId: number
): Promise<void> {
  await githubFetch({
    ctx,
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
  ctx: RequestContext,
  owner: string,
  repo: string,
  opts: {
    name: string;
    headSha: string;
    status: "queued" | "in_progress" | "completed";
    /** Conclusion is only valid when status === "completed". */
    conclusion?: "success" | "failure" | "cancelled" | "neutral" | "skipped";
    detailsUrl?: string;
    output?: { title: string; summary: string; text?: string };
  },
): Promise<{ id: number; htmlUrl?: string } | null> {
  try {
    const data = await githubFetch<{ id: number; html_url?: string }>({
      ctx,
      owner,
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs`,
      method: "POST",
      params: {
        name: opts.name,
        head_sha: opts.headSha,
        status: opts.status,
        started_at: new Date().toISOString(),
        ...(opts.status === "completed"
          ? { completed_at: new Date().toISOString(), conclusion: opts.conclusion }
          : {}),
        details_url: opts.detailsUrl,
        output: opts.output,
      },
    });
    return { id: data.id, htmlUrl: data.html_url };
  } catch {
    return null;
  }
}

/**
 * Update an existing check run (e.g. mark as completed).
 */
export async function updateCheckRun(
  ctx: RequestContext,
  owner: string,
  repo: string,
  checkRunId: number,
  opts: {
    status: "completed";
    conclusion: "success" | "failure" | "cancelled" | "neutral" | "skipped";
    output?: { title: string; summary: string; text?: string };
  },
): Promise<void> {
  try {
    await githubFetch({
      ctx,
      owner,
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs/${checkRunId}`,
      method: "PATCH",
      params: {
        status: opts.status,
        completed_at: new Date().toISOString(),
        conclusion: opts.conclusion,
        ...(opts.output ? { output: opts.output } : {}),
      },
    });
  } catch {
    /* best-effort - don't fail the deployment if check update fails */
  }
}

// ─── User organisations ──────────────────────────────────────────────────────

// The library "home" view (getUserHome), the Settings connection-status data
// (getConnectionStatus), and the "Local only" badge rule all MOVED into the
// GitHubSource adapter (./sources): GhCliSource / GitHubAppSource own the
// listing + status, LocalGitHubSource (the merge) composes them. Controllers
// call createGitHubSource(ctx).getHome() / .getConnectionStatus() directly —
// no service-layer wrappers.

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

  // For non-app modes, check if the URL is publicly reachable. Uses the
  // resolved PUBLIC url (OPENSHIP_PUBLIC_URL via the same-origin proxy) so a
  // `--public-url` VPS gets "repo" instead of "none" — the localhost fallback
  // is only hit when no public URL is configured.
  const url = resolveApiPublicUrl();
  if (isLocalUrl(url)) return "none";
  return "repo";
}

/**
 * Resolve the effective webhook strategy for a project + user (async).
 *
 * Priority:
 *   1. "app"    - GitHub App (cloud mode)
 *   2. "domain" - project has a webhookDomain set (direct delivery)
 *   3. "repo"   - current API target is public
 *   4. "none"   - no way to receive webhooks
 */
export async function resolveWebhookStrategy(
  project?: { webhookDomain?: string | null },
): Promise<WebhookStrategy> {
  const base = getWebhookStrategy();
  if (base === "app") return "app";

  // Project has a domain configured → direct webhook delivery
  if (project?.webhookDomain) return "domain";

  // Public API target → repo-level webhooks
  if (base === "repo") return "repo";

  return "none";
}

/**
 * Get the list of available webhook strategies for a user + project.
 * Used by the dashboard to show options to the user.
 */
export async function getAvailableStrategies(
  ctx: RequestContext,
  project?: { webhookDomain?: string | null },
): Promise<{ current: WebhookStrategy; available: WebhookStrategy[] }> {
  const current = await resolveWebhookStrategy(project);
  const available: WebhookStrategy[] = [];

  if (getGitHubAuthMode() === "app") {
    available.push("app");
    return { current, available };
  }

  // Domain is always available if verified domains exist (handled by UI)
  available.push("domain");

  if (!isLocalUrl(resolveApiPublicUrl())) {
    available.push("repo");
  }

  return { current, available };
}

/**
 * True when the URL points to a host that is NOT reachable from the
 * public internet — so GitHub's webhook delivery would fail.
 *
 * Used to decide between webhook strategies in resolveWebhookStrategy:
 *   - reachable → "repo" (per-repo webhook directly to this URL)
 *   - unreachable → "none" (caller falls back to polling or domain
 *     delivery via the project's webhookDomain)
 *
 * Conservative on parse failure (returns true). A typo'd URL is safer
 * to assume unreachable than to register a webhook GitHub will never
 * be able to deliver to.
 *
 * Covers the full set of non-routable host shapes:
 *   - DNS sentinels: localhost, *.local (mDNS)
 *   - IPv4 loopback: 127.0.0.0/8 (ALL of 127, not just .0.1)
 *   - IPv4 unspecified: 0.0.0.0
 *   - IPv4 RFC1918 private: 10/8, 172.16/12, 192.168/16
 *   - IPv4 link-local / APIPA: 169.254.0.0/16
 *   - IPv6 loopback: ::1 (with optional [::1] bracket form)
 *   - IPv6 link-local: fe80::/10
 *   - IPv6 ULA: fc00::/7 (fc/fd prefix)
 */
function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    if (!hostname) return true;

    // DNS sentinel cases. `.local` is mDNS (Bonjour) — reachable only on
    // the local link, never from the public internet.
    if (
      hostname === "localhost" ||
      hostname === "0.0.0.0" ||
      hostname.endsWith(".local")
    ) {
      return true;
    }

    // IPv6 (URL parses bracketed form; strip the brackets for matching).
    // Same hostname can also arrive un-bracketed if the caller passed a
    // bare IP. fe80::/10 → fe80..febf (first byte top 10 bits); fc00::/7
    // → fc00..fdff (first byte top 7 bits, fc or fd).
    const v6 = hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
    if (v6 === "::1") return true;
    if (/^fe[89ab][0-9a-f]?:/i.test(v6)) return true; // link-local
    if (/^f[cd][0-9a-f]{2}:/i.test(v6)) return true; // ULA

    // IPv4: full 127/8 + 0/8-sentinel handled above + RFC1918 + link-local.
    // (Not collapsed into a single regex — readability beats brevity here,
    // and each /8|/12|/16 has a different intent that benefits from being
    // named in the source.)
    if (/^127\./.test(hostname)) return true;                       // loopback /8
    if (/^10\./.test(hostname)) return true;                        // RFC1918 /8
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;   // RFC1918 /12
    if (/^192\.168\./.test(hostname)) return true;                  // RFC1918 /16
    if (/^169\.254\./.test(hostname)) return true;                  // link-local /16

    return false;
  } catch {
    return true;
  }
}

// ─── Webhook registration ────────────────────────────────────────────────────

/**
 * Mint a fresh webhook signing secret for a project. Single source of
 * truth so registration and rotation pick the same generator. Returns
 * the raw secret (which goes to GitHub) — the caller MUST encrypt
 * before persisting to the project row.
 */
export function mintWebhookSecret(): string {
  return randomBytes(WEBHOOK_SECRET_BYTES).toString("hex");
}

/**
 * Persist a freshly-minted webhook secret on the project row, encrypted
 * via the standard lib/encryption helper. Used by both registerWebhook
 * (first-time registration) and rotateProjectWebhookSecret (operator-
 * initiated rotation).
 */
async function persistProjectWebhookSecret(
  projectId: string,
  secret: string,
): Promise<void> {
  await dbRepos.project.update(projectId, {
    webhookSecret: encrypt(secret),
  });
}

/**
 * Resolve the signing secret for a project. Decrypts the per-project
 * value when present; falls back to env.GITHUB_WEBHOOK_SECRET for
 * legacy webhooks registered before per-project secrets existed.
 *
 * Returns null when neither is configured — the caller (webhook
 * verifier) is then on the self-hosted "unsigned webhooks allowed
 * during setup" path.
 */
export function resolveProjectWebhookSecret(
  project: { webhookSecret?: string | null } | null | undefined,
): string | null {
  if (project?.webhookSecret) {
    try {
      return decrypt(project.webhookSecret);
    } catch {
      // Encryption key rotation / corrupted row — fall through to env
      // rather than silently rejecting every webhook for this project.
      console.warn(
        "[GitHub Webhook] project.webhookSecret failed to decrypt; falling back to env.GITHUB_WEBHOOK_SECRET",
      );
    }
  }
  return env.GITHUB_WEBHOOK_SECRET || null;
}

/**
 * REGISTER-side per-project secret: reuse the project's existing (decrypted)
 * secret when it has one — so re-registration is idempotent and never rotates
 * a working hook — otherwise mint a fresh one and persist it. Unlike
 * `resolveProjectWebhookSecret` (the VERIFY-side reader, which falls back to
 * `env.GITHUB_WEBHOOK_SECRET`), this NEVER uses the env secret: every project
 * gets its OWN secret, so self-hosted auto-deploy no longer depends on the
 * (legacy) global env var and one project's leak can't verify another's.
 */
async function ensureProjectWebhookSecret(projectId: string): Promise<string> {
  const proj = await dbRepos.project.findById(projectId).catch(() => null);
  if (proj?.webhookSecret) {
    try {
      return decrypt(proj.webhookSecret);
    } catch {
      // Corrupted row / key rotation — mint a fresh one below and overwrite.
      console.warn(
        "[GitHub Webhook] existing project.webhookSecret failed to decrypt; minting a fresh secret",
      );
    }
  }
  const secret = mintWebhookSecret();
  await persistProjectWebhookSecret(projectId, secret);
  return secret;
}

/**
 * Register a deploy webhook on a repo.
 * If creation returns 422 (already exists), finds the existing hook.
 *
 * Callers should check `getWebhookStrategy()` before calling - this will
 * throw if the URL is unreachable (localhost).
 *
 * HIGH #9 — when a `projectId` is supplied, this uses that project's OWN
 * webhook secret (reused if already set, else freshly minted + persisted via
 * `ensureProjectWebhookSecret`) and sends it to GitHub in the hook config.
 * Re-registration is idempotent — it never rotates a working hook. Each
 * project gets its own secret so a leak (or rotation of one) doesn't
 * compromise others, and self-hosted auto-deploy no longer depends on the
 * legacy global env secret. Without `projectId` we fall back to
 * env.GITHUB_WEBHOOK_SECRET — the SaaS App secret + the legacy
 * /github/repos/:owner/:repo/webhooks endpoint that isn't tied to a project.
 */
export async function registerWebhook(
  ctx: RequestContext,
  owner: string,
  repo: string,
  webhookUrl = sharedWebhookUrl(),
  opts: { projectId?: string } = {},
): Promise<{ hookId: number | null; events: string[] }> {
  // Per-project secret (reuse-or-mint, persisted by ensureProjectWebhookSecret)
  // for project-scoped registrations; env fallback for project-less callers.
  const secret = opts.projectId
    ? await ensureProjectWebhookSecret(opts.projectId)
    : env.GITHUB_WEBHOOK_SECRET || undefined;

  try {
    const result = await createWebhook(
      ctx,
      owner,
      repo,
      webhookUrl,
      secret || undefined,
    );
    return { hookId: result.hookId, events: result.events };
  } catch (err) {
    /* 422 = webhook already exists - find it */
    if (err instanceof Error && err.message.includes("422")) {
      const existing = await listWebhooks(ctx, owner, repo);
      const targetUrl = normalizeWebhookUrl(webhookUrl);
      const match = existing.find((h) =>
        normalizeWebhookUrl(h.config?.url) === targetUrl,
      );
      if (!match) return { hookId: null, events: [] };

      const config = secret
        ? {
            url: webhookUrl,
            content_type: "json",
            secret,
          }
        : undefined;
      const updated = await updateWebhook(ctx, owner, repo, match.id, {
        active: true,
        events: [...GITHUB_DEPLOY_WEBHOOK_EVENTS],
        config,
      });
      // We push `secret` into GitHub's hook config so the local verifier
      // matches. It's already persisted (ensureProjectWebhookSecret for a
      // project, or the env secret for a project-less caller) — no re-store.
      return { hookId: updated.id, events: updated.events };
    }
    throw err;
  }
}

/**
 * Self-hosted webhook-secret backfill (boot sweep). Existing auto-deploy
 * projects whose hook was registered before per-project secrets were wired
 * (webhookId set, webhookSecret null) either verify against the legacy env
 * secret — or, if the operator followed the "GITHUB_WEBHOOK_SECRET is ignored"
 * guidance, the hook was registered with NO secret and every delivery
 * fails-closed. Re-register each (idempotent — hits registerWebhook's 422→
 * update path) to mint + persist a per-project secret and push it to GitHub.
 *
 * Best-effort + bounded (one query; self-hosted = few projects), and runs once
 * per project (the row drops out of the query once its secret is set). No-op in
 * CLOUD_MODE — the SaaS App owns a single webhook secret, not per-repo hooks.
 */
export async function backfillWebhookSecrets(): Promise<void> {
  if (env.CLOUD_MODE) return;
  const projects = await dbRepos.project.listNeedingWebhookBackfill().catch(() => []);
  for (const p of projects) {
    if (!p.gitOwner || !p.gitRepo) continue;
    try {
      const owner = await resolveOrgOwner(p.organizationId).catch(() => null);
      if (!owner?.userId) continue;
      const ctx = buildBackgroundContext({
        userId: owner.userId,
        organizationId: p.organizationId,
        label: "webhook:backfill-secret",
      });
      const url = p.webhookDomain ? domainWebhookUrl(p.webhookDomain) : sharedWebhookUrl();
      await registerWebhook(ctx, p.gitOwner, p.gitRepo, url, { projectId: p.id });
      console.log(
        `[GitHub Webhook] backfilled per-project secret for ${p.gitOwner}/${p.gitRepo} (project ${p.id})`,
      );
    } catch (err) {
      console.warn(
        `[GitHub Webhook] webhook-secret backfill failed for project ${p.id}: ${safeErrorMessage(err)}`,
      );
    }
  }
}

/**
 * Rotate the webhook signing secret for a project. Mints a new secret,
 * pushes it to GitHub via PATCH /repos/:owner/:repo/hooks/:hookId, and
 * persists the encrypted value on the project row. Idempotent at the
 * GitHub side — the hook keeps its id, only the secret changes.
 *
 * Throws if the project row can't be found or doesn't have a registered
 * webhook yet (caller should run registerWebhook first).
 */
export async function rotateProjectWebhookSecret(
  ctx: RequestContext,
  projectId: string,
): Promise<{ rotated: true; hookId: number }> {
  const project = await dbRepos.project.findById(projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }
  if (!project.webhookId || !project.gitOwner || !project.gitRepo) {
    throw new Error(
      `Project ${projectId} has no registered webhook to rotate — register one first.`,
    );
  }

  const fresh = mintWebhookSecret();
  // Preserve the hook's delivery URL for its strategy — a domain-strategy hook
  // must keep pointing at the project's `/_openship/hooks/` vhook, NOT get
  // rewritten to the shared endpoint (which previously broke delivery on rotate).
  const webhookUrl = project.webhookDomain
    ? domainWebhookUrl(project.webhookDomain)
    : sharedWebhookUrl();
  await updateWebhook(ctx, project.gitOwner, project.gitRepo, project.webhookId, {
    active: true,
    events: [...GITHUB_DEPLOY_WEBHOOK_EVENTS],
    config: { url: webhookUrl, content_type: "json", secret: fresh },
  });
  await persistProjectWebhookSecret(projectId, fresh);
  return { rotated: true, hookId: project.webhookId };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract owner/repo from a GitHub URL. Handles both the https
 * (`https://github.com/owner/repo(.git)`) and SSH
 * (`git@github.com:owner/repo(.git)`) forms; returns null for non-GitHub hosts.
 * Single source of truth for GitHub URL parsing on the API side.
 */
export function parseRepoUrl(repoUrl?: string): { owner: string; repo: string } | null {
  if (!repoUrl || !/github\.com/i.test(repoUrl)) return null;
  const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]! };
}
