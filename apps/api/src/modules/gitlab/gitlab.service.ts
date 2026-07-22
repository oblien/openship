/**
 * GitLab service — list projects/branches, parse URLs, register webhooks.
 */

import { randomBytes } from "crypto";
import { repos } from "@repo/db";
import { encrypt, decrypt } from "../../lib/encryption";
import { sharedGitlabWebhookUrl } from "../../lib/public-url";
import type { RequestContext } from "../../lib/request-context";
import { requireTokenFor, tokenFor } from "./gitlab.token";
import { glFetch, gitlabWebBase, gitlabApiBase } from "./gitlab.http";
import { resolveGitlabUserCredential } from "./gitlab.auth";
import type {
  GitLabBranch,
  GitLabHook,
  GitLabNamespace,
  GitLabProject,
  MappedGitLabAccount,
  MappedGitLabProject,
} from "./gitlab.types";

const WEBHOOK_SECRET_BYTES = 32;
export const GITLAB_PUSH_EVENTS = ["push_events"] as const;

function mapProject(p: GitLabProject): MappedGitLabProject {
  const full = p.path_with_namespace;
  const lastSlash = full.lastIndexOf("/");
  const owner = lastSlash >= 0 ? full.slice(0, lastSlash) : p.namespace.full_path;
  const repo = lastSlash >= 0 ? full.slice(lastSlash + 1) : p.path;
  return {
    id: p.id,
    name: p.name,
    owner,
    repo,
    fullName: full,
    private: p.visibility !== "public",
    defaultBranch: p.default_branch ?? "main",
    htmlUrl: p.web_url,
    cloneUrl: p.http_url_to_repo,
    sshUrl: p.ssh_url_to_repo,
    description: p.description,
    updatedAt: p.last_activity_at,
  };
}

async function requireCred(ctx: RequestContext) {
  return requireTokenFor(ctx, "local", {});
}

export async function listNamespaces(ctx: RequestContext): Promise<MappedGitLabAccount[]> {
  const { token } = await requireCred(ctx);
  const groups = await glFetch<GitLabNamespace[]>(token, {
    path: "/groups",
    params: { min_access_level: 30, per_page: 100 },
  });
  const user = await glFetch<{ id: number; username: string; name: string; avatar_url: string }>(
    token,
    { path: "/user" },
  );

  const accounts: MappedGitLabAccount[] = [
    {
      id: user.id,
      login: user.username,
      name: user.name || user.username,
      avatarUrl: user.avatar_url,
      kind: "user",
      fullPath: user.username,
    },
    ...groups.map((g) => ({
      id: g.id,
      login: g.full_path,
      name: g.name,
      avatarUrl: g.avatar_url,
      kind: "group" as const,
      fullPath: g.full_path,
    })),
  ];
  return accounts;
}

export async function listProjects(
  ctx: RequestContext,
  opts: { namespace?: string; search?: string } = {},
): Promise<MappedGitLabProject[]> {
  const { token } = await requireCred(ctx);
  const params: Record<string, unknown> = {
    membership: true,
    simple: false,
    order_by: "last_activity_at",
    sort: "desc",
    per_page: 100,
  };
  if (opts.search) params.search = opts.search;

  let projects: GitLabProject[];
  if (opts.namespace) {
    // Prefer namespace-scoped listing when a group/user path is selected.
    const encoded = encodeURIComponent(opts.namespace);
    try {
      projects = await glFetch<GitLabProject[]>(token, {
        path: `/groups/${encoded}/projects`,
        params: { include_subgroups: true, per_page: 100, order_by: "last_activity_at", sort: "desc" },
      });
    } catch {
      // User namespace (not a group) — fall back to membership list + filter.
      const all = await glFetch<GitLabProject[]>(token, { path: "/projects", params });
      const ns = opts.namespace.toLowerCase();
      projects = all.filter(
        (p) =>
          p.namespace.full_path.toLowerCase() === ns ||
          p.path_with_namespace.toLowerCase().startsWith(`${ns}/`),
      );
    }
  } else {
    projects = await glFetch<GitLabProject[]>(token, { path: "/projects", params });
  }

  return projects.map(mapProject);
}

export async function getProject(
  ctx: RequestContext,
  projectId: number,
): Promise<MappedGitLabProject> {
  const { token } = await requireCred(ctx);
  const p = await glFetch<GitLabProject>(token, {
    path: `/projects/${projectId}`,
  });
  return mapProject(p);
}

export async function listTree(
  ctx: RequestContext,
  projectId: number,
  opts: { ref?: string; path?: string; recursive?: boolean } = {},
): Promise<Array<{ name: string; path: string; type: "tree" | "blob" }>> {
  const { token } = await requireCred(ctx);
  return glFetch(token, {
    path: `/projects/${projectId}/repository/tree`,
    params: {
      ref: opts.ref ?? "HEAD",
      path: opts.path ?? "",
      recursive: opts.recursive ?? false,
      per_page: 100,
    },
  });
}

export async function getFileRaw(
  ctx: RequestContext,
  projectId: number,
  filePath: string,
  ref = "HEAD",
): Promise<string | undefined> {
  const { token } = await requireCred(ctx);
  const encoded = encodeURIComponent(filePath);
  try {
    const base = gitlabApiBase();
    const url = `${base}/projects/${projectId}/repository/files/${encoded}/raw?ref=${encodeURIComponent(ref)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return undefined;
    return await res.text();
  } catch {
    return undefined;
  }
}

export async function listBranches(
  ctx: RequestContext,
  projectId: number,
): Promise<Array<{ name: string; protected: boolean; default: boolean }>> {
  const { token } = await requireCred(ctx);
  const branches = await glFetch<GitLabBranch[]>(token, {
    path: `/projects/${projectId}/repository/branches`,
    params: { per_page: 100 },
  });
  return branches.map((b) => ({
    name: b.name,
    protected: b.protected,
    default: b.default,
  }));
}

export function mintWebhookSecret(): string {
  return randomBytes(WEBHOOK_SECRET_BYTES).toString("hex");
}

async function ensureProjectWebhookSecret(projectId: string): Promise<string> {
  const proj = await repos.project.findById(projectId).catch(() => null);
  if (proj?.webhookSecret) {
    try {
      return decrypt(proj.webhookSecret);
    } catch {
      // mint fresh below
    }
  }
  const secret = mintWebhookSecret();
  await repos.project.update(projectId, { webhookSecret: encrypt(secret) });
  return secret;
}

/**
 * Register a Push Hook on a GitLab project. Throws with a clear message when
 * the token lacks webhook scope (do not silently skip).
 */
export async function registerWebhook(
  ctx: RequestContext,
  gitlabProjectId: number,
  webhookUrl = sharedGitlabWebhookUrl(),
  opts: { projectId?: string } = {},
): Promise<{ hookId: number; url: string }> {
  const { token } = await requireCred(ctx);
  const secret = opts.projectId
    ? await ensureProjectWebhookSecret(opts.projectId)
    : mintWebhookSecret();

  try {
    const hook = await glFetch<GitLabHook>(token, {
      path: `/projects/${gitlabProjectId}/hooks`,
      method: "POST",
      params: {
        url: webhookUrl,
        token: secret,
        push_events: true,
        enable_ssl_verification: true,
      },
    });
    return { hookId: hook.id, url: webhookUrl };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("403") || msg.includes("401")) {
      throw new Error(
        "GitLab token lacks permission to register webhooks. Grant the `api` scope (OAuth) or use a PAT with `api` / Maintainer access, then reconnect.",
      );
    }
    // Hook may already exist — find and update.
    if (msg.includes("422") || msg.includes("already")) {
      const existing = await listWebhooks(ctx, gitlabProjectId);
      const match = existing.find((h) => normalizeUrl(h.url) === normalizeUrl(webhookUrl));
      if (match) {
        await glFetch(token, {
          path: `/projects/${gitlabProjectId}/hooks/${match.id}`,
          method: "PUT",
          params: {
            url: webhookUrl,
            token: secret,
            push_events: true,
            enable_ssl_verification: true,
          },
        });
        return { hookId: match.id, url: webhookUrl };
      }
    }
    throw err;
  }
}

export async function listWebhooks(
  ctx: RequestContext,
  gitlabProjectId: number,
): Promise<GitLabHook[]> {
  const { token } = await requireCred(ctx);
  return glFetch<GitLabHook[]>(token, {
    path: `/projects/${gitlabProjectId}/hooks`,
  });
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

/**
 * Parse a GitLab HTTPS/SSH URL into owner (namespace path) + repo.
 * Supports nested groups and self-hosted hosts matching GITLAB_BASE_URL.
 */
export function parseGitlabRepoUrl(
  repoUrl?: string,
): { owner: string; repo: string; host: string } | null {
  if (!repoUrl?.trim()) return null;
  const configuredHost = (() => {
    try {
      return new URL(gitlabWebBase()).hostname.toLowerCase();
    } catch {
      return "gitlab.com";
    }
  })();

  // SSH: git@host:group/sub/project.git
  const ssh = repoUrl.match(/^git@([^:]+):(.+?)(?:\.git)?\/?$/i);
  if (ssh) {
    const host = ssh[1]!.toLowerCase();
    if (host !== configuredHost && host !== "gitlab.com") {
      // Allow configured host or gitlab.com; reject unrelated hosts.
      if (configuredHost !== host) return null;
    }
    const path = ssh[2]!.replace(/\/$/, "");
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash <= 0) return null;
    return {
      owner: path.slice(0, lastSlash),
      repo: path.slice(lastSlash + 1),
      host,
    };
  }

  try {
    const u = new URL(repoUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase();
    if (host !== configuredHost && host !== "gitlab.com") return null;
    const parts = u.pathname
      .replace(/^\//, "")
      .replace(/\.git$/i, "")
      .replace(/\/$/, "")
      .split("/")
      .filter(Boolean);
    if (parts.length < 2) return null;
    const repo = parts[parts.length - 1]!;
    const owner = parts.slice(0, -1).join("/");
    return { owner, repo, host };
  } catch {
    return null;
  }
}

/** Split path_with_namespace into owner + repo. */
export function splitPathWithNamespace(
  pathWithNamespace: string,
): { owner: string; repo: string } | null {
  const trimmed = pathWithNamespace.replace(/^\/+|\/+$/g, "");
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  return {
    owner: trimmed.slice(0, lastSlash),
    repo: trimmed.slice(lastSlash + 1),
  };
}

export async function resolveCloneToken(
  ctx: RequestContext,
  projectId?: string,
): Promise<{ token: string; username: string; cloneUrlPrefix: string } | null> {
  const r = await tokenFor(ctx, "local", { projectId });
  if (!r) {
    const cred = await resolveGitlabUserCredential(ctx.userId);
    if (!cred) return null;
    return {
      token: cred.token,
      username: "oauth2",
      cloneUrlPrefix: gitlabWebBase(),
    };
  }
  return {
    token: r.token,
    username: "oauth2",
    cloneUrlPrefix: gitlabWebBase(),
  };
}
