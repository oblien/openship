/**
 * Utility functions for encoding and decoding repository slugs
 * Uses base64url encoding (URL-safe base64) for owner/repo format
 */

import { diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
const LOCAL_PREFIX = "local:";
const UPLOAD_PREFIX = "upload:";
const REPO_V2_PREFIX = "repo:v2:";
const PROJECT_PREFIX = "project:";

type DecodedSlug =
  | { kind: "repo"; owner: string; repo: string; branch?: string; projectId?: string }
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

    const [owner, repo] = decoded.split('/');
    if (!owner || !repo) return null;
    return { kind: "repo", owner, repo };
  } catch {
    return null;
  }
}

/**
 * Extracts owner and repo from a GitHub URL
 * @param url - GitHub repository URL
 * @returns Object with owner and repo, or null if invalid
 */
export function extractOwnerRepoFromUrl(url: string): { owner: string; repo: string } | null {
  try {
    // Handle various GitHub URL formats
    // https://github.com/owner/repo
    // https://github.com/owner/repo.git
    // git@github.com:owner/repo.git
    
    // Match HTTPS URLs - allow dots in repo name, optionally strip .git suffix
    const httpsMatch = url.match(/github\.com\/([^\/]+)\/(.+?)(?:\.git)?$/);
    if (httpsMatch) {
      return {
        owner: httpsMatch[1],
        repo: httpsMatch[2],
      };
    }
    
    // Match SSH URLs - allow dots in repo name, optionally strip .git suffix
    const sshMatch = url.match(/github\.com:([^\/]+)\/(.+?)(?:\.git)?$/);
    if (sshMatch) {
      return {
        owner: sshMatch[1],
        repo: sshMatch[2],
      };
    }
    
    return null;
  } catch (error) {
    errorDiagnostics.error("dashboard/utils/repoSlug", 'Failed to extract owner/repo from URL:', error);
    return null;
  }
}
