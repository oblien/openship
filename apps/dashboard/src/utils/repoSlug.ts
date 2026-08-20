/**
 * Utility functions for encoding and decoding repository slugs
 * Uses base64url encoding (URL-safe base64) for owner/repo format
 */

import { buildGitUrl, parseGitRepoUrl } from "@repo/core";

const LOCAL_PREFIX = "local:";
const UPLOAD_PREFIX = "upload:";
const REPO_V2_PREFIX = "repo:v2:";
const PROJECT_PREFIX = "project:";

export type GitSlugProvider = "github" | "azure";

export type DecodedSlug =
  | {
      kind: "repo";
      owner: string;
      repo: string;
      branch?: string;
      projectId?: string;
      /** Absent on legacy GitHub slugs — treat as github. */
      provider?: GitSlugProvider;
      /** Azure DevOps project name. */
      project?: string;
    }
  | { kind: "local"; path: string }
  | { kind: "upload"; sessionId: string }
  | { kind: "project"; projectId: string };

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
 * Encodes a git source that may not be GitHub. Azure always uses the v2 JSON
 * payload so the Azure project name survives the round trip. GitHub without
 * extra fields keeps the legacy `owner/repo` encoding.
 */
export function encodeProviderRepoSlug(
  provider: GitSlugProvider,
  owner: string,
  repo: string,
  project?: string,
): string {
  switch (provider) {
    case "github":
      if (!project) return encodeRepoSlug(owner, repo);
      break;
    case "azure":
      if (!project) {
        throw new Error("Azure DevOps slug requires a project name");
      }
      break;
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unsupported git provider: ${_exhaustive}`);
    }
  }
  const payload: Record<string, string> = { owner, repo, provider };
  if (project) payload.project = project;
  return encodeBase64Url(REPO_V2_PREFIX + JSON.stringify(payload));
}

/** Encode a persisted project git identity for `/deploy/{slug}`. */
export function encodeGitSourceSlug(input: {
  provider?: string | null;
  owner: string;
  repo: string;
  project?: string | null;
}): string {
  const provider = (input.provider ?? "github").toLowerCase() === "azure" ? "azure" : "github";
  return encodeProviderRepoSlug(provider, input.owner, input.repo, input.project ?? undefined);
}

export function gitSourceLabel(input: {
  provider?: string | null;
  owner: string;
  repo: string;
  project?: string | null;
}): string {
  if ((input.provider ?? "").toLowerCase() === "azure" && input.project) {
    return `${input.owner}/${input.project}/${input.repo}`;
  }
  return `${input.owner}/${input.repo}`;
}

export function gitSourceHref(input: {
  provider?: string | null;
  owner: string;
  repo: string;
  project?: string | null;
}): string | null {
  const provider = (input.provider ?? "github").toLowerCase() === "azure" ? "azure" : "github";
  try {
    return buildGitUrl(provider, input.owner, input.repo, input.project ?? undefined);
  } catch {
    return null;
  }
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

      const { owner, repo, branch, projectId, provider, project } = payload as Record<string, unknown>;
      if (typeof owner !== "string" || typeof repo !== "string" || !owner || !repo) {
        return null;
      }

      const gitProvider: GitSlugProvider | undefined =
        provider === "azure" || provider === "github" ? provider : undefined;
      const azureProject = typeof project === "string" && project ? project : undefined;
      if (gitProvider === "azure" && !azureProject) return null;

      return {
        kind: "repo",
        owner,
        repo,
        ...(typeof branch === "string" && branch ? { branch } : {}),
        ...(typeof projectId === "string" && projectId ? { projectId } : {}),
        ...(gitProvider ? { provider: gitProvider } : {}),
        ...(azureProject ? { project: azureProject } : {}),
      };
    }

    const [owner, repo] = decoded.split('/');
    if (!owner || !repo) return null;
    return { kind: "repo", owner, repo };
  } catch {
    return null;
  }
}

/**
 * Extracts owner/repo (+ Azure project) from a GitHub or Azure DevOps URL.
 */
export function extractOwnerRepoFromUrl(url: string): {
  owner: string;
  repo: string;
  provider: GitSlugProvider;
  project?: string;
} | null {
  const parsed = parseGitRepoUrl(url);
  if (!parsed) return null;
  return {
    owner: parsed.owner,
    repo: parsed.repo,
    provider: parsed.provider,
    ...(parsed.project ? { project: parsed.project } : {}),
  };
}
