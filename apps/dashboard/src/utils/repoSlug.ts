/**
 * Utility functions for encoding and decoding repository slugs
 * Uses base64url encoding (URL-safe base64) for owner/repo format
 */

const LOCAL_PREFIX = "local:";
const UPLOAD_PREFIX = "upload:";
const REPO_V2_PREFIX = "repo:v2:";
const PROJECT_PREFIX = "project:";

type DecodedSlug =
  | { kind: "repo"; owner: string; repo: string; branch?: string; projectId?: string }
  | { kind: "local"; path: string }
  | { kind: "upload"; sessionId: string }
  | { kind: "project"; projectId: string };

/**
 * Splits a decoded "owner/.../repo" payload into { owner, repo }, treating the
 * LAST segment as the repo and everything before it as the owner. GitHub
 * owners are always a single segment, but GitLab namespaces can nest
 * arbitrarily deep (group/subgroup/subsubgroup/project) — a naive first-"/"
 * split would truncate those to the top-level group and drop the rest.
 */
function splitOwnerRepo(decoded: string): { owner: string; repo: string } | null {
  const parts = decoded.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const repo = parts.pop() as string;
  const owner = parts.join("/");
  if (!owner || !repo) return null;
  return { owner, repo };
}

function encodeBase64Url(data: string): string {
  const base64 = Buffer.from(data).toString('base64');
  return base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Encodes owner and repo into a URL-safe base64 slug
 */
export function encodeRepoSlug(owner: string, repo: string): string {
  return encodeBase64Url(`${owner}/${repo}`);
}

/**
 * Encodes a local path into a URL-safe base64 slug (prefixed with "local:")
 */
export function encodeLocalSlug(path: string): string {
  const data = LOCAL_PREFIX + path;
  return encodeBase64Url(data);
}

/**
 * Encodes a folder-upload session id into a URL-safe slug (prefixed "upload:").
 * The deploy wizard decodes it and re-fetches the scan for that session.
 */
export function encodeUploadSlug(sessionId: string): string {
  return encodeBase64Url(UPLOAD_PREFIX + sessionId);
}

/**
 * Encodes an existing project id into a URL-safe slug (prefixed "project:").
 * The deploy wizard decodes it and hydrates from the project's DB rows — used
 * by one-click apps and any repo-less project that deploys from its saved config.
 */
export function encodeProjectSlug(projectId: string): string {
  return encodeBase64Url(PROJECT_PREFIX + projectId);
}

/**
 * Decodes a slug back to either a repo, local path, or upload session
 */
export function decodeSlug(slug: string): DecodedSlug | null {
  try {
    let base64 = slug
      .replace(/-/g, '+')
      .replace(/_/g, '/');

    while (base64.length % 4) {
      base64 += '=';
    }

    const decoded = Buffer.from(base64, 'base64').toString('utf-8');

    if (decoded.startsWith(LOCAL_PREFIX)) {
      const path = decoded.slice(LOCAL_PREFIX.length);
      return path ? { kind: "local", path } : null;
    }

    if (decoded.startsWith(UPLOAD_PREFIX)) {
      const sessionId = decoded.slice(UPLOAD_PREFIX.length);
      return sessionId ? { kind: "upload", sessionId } : null;
    }

    if (decoded.startsWith(PROJECT_PREFIX)) {
      const projectId = decoded.slice(PROJECT_PREFIX.length);
      return projectId ? { kind: "project", projectId } : null;
    }

    if (decoded.startsWith(REPO_V2_PREFIX)) {
      const payload = JSON.parse(decoded.slice(REPO_V2_PREFIX.length));
      if (!payload || typeof payload !== "object") return null;

      const { owner, repo, branch, projectId } = payload as Record<string, unknown>;
      if (typeof owner !== "string" || typeof repo !== "string" || !owner || !repo) {
        return null;
      }

      return {
        kind: "repo",
        owner,
        repo,
        ...(typeof branch === "string" && branch ? { branch } : {}),
        ...(typeof projectId === "string" && projectId ? { projectId } : {}),
      };
    }

    const split = splitOwnerRepo(decoded);
    if (!split) return null;
    return { kind: "repo", owner: split.owner, repo: split.repo };
  } catch {
    return null;
  }
}

/**
 * Extracts owner, repo, and provider from a GitHub or GitLab URL.
 * @param url - GitHub or GitLab repository URL
 * @returns Object with owner, repo, and provider, or null if invalid
 */
export function extractOwnerRepoFromUrl(
  url: string,
): { owner: string; repo: string; provider: "github" | "gitlab" } | null {
  try {
    // GitHub — always a single-segment owner.
    // https://github.com/owner/repo(.git)?
    const githubHttpsMatch = url.match(/github\.com\/([^\/]+)\/(.+?)(?:\.git)?$/);
    if (githubHttpsMatch) {
      return { owner: githubHttpsMatch[1], repo: githubHttpsMatch[2], provider: "github" };
    }
    // git@github.com:owner/repo.git
    const githubSshMatch = url.match(/github\.com:([^\/]+)\/(.+?)(?:\.git)?$/);
    if (githubSshMatch) {
      return { owner: githubSshMatch[1], repo: githubSshMatch[2], provider: "github" };
    }

    // GitLab — namespace can nest arbitrarily (group/subgroup/.../project), so
    // take everything up to the last path segment as the owner. Matches
    // gitlab.com and self-hosted hosts (any non-github.com HTTPS/SSH forge URL).
    const gitlabHttpsMatch = url.match(
      /^https?:\/\/(?!github\.com)([^\/]+)\/([^?#]+?)(?:\.git)?\/?$/i,
    );
    if (gitlabHttpsMatch) {
      const split = splitOwnerRepo(gitlabHttpsMatch[2]!);
      if (split) return { ...split, provider: "gitlab" };
    }
    // git@host:group/subgroup/project.git (not github.com)
    const gitlabSshMatch = url.match(
      /^git@(?!github\.com)([^:]+):([^?#]+?)(?:\.git)?\/?$/i,
    );
    if (gitlabSshMatch) {
      const split = splitOwnerRepo(gitlabSshMatch[2]!);
      if (split) return { ...split, provider: "gitlab" };
    }

    return null;
  } catch (error) {
    console.error('Failed to extract owner/repo from URL:', error);
    return null;
  }
}
