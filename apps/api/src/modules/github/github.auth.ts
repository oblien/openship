/**
 * GitHub auth — handles GitHub App JWT, installation tokens, and user tokens.
 *
 * This module is the single source of truth for authenticating with the GitHub API.
 * It manages:
 *   - App-level JWT generation (for GitHub App endpoints)
 *   - Installation access tokens (for repo-scoped operations)
 *   - User OAuth tokens (for user-scoped operations, via Better Auth)
 *   - A thin `githubFetch` helper that picks the right auth automatically
 *
 * Token caching uses a simple in-memory Map with TTL to avoid hitting
 * GitHub's token endpoint on every request.
 */

import crypto from "crypto";
import { repos } from "@repo/db";
import { env } from "../../config/env";
import { TtlCache } from "../../lib/cache";
import type { GitHubInstallation, MappedAccount } from "./github.types";

// ─── Token cache ─────────────────────────────────────────────────────────────

const tokenCache = new TtlCache<string>({ maxSize: 5_000, sweepIntervalMs: 60_000 });

// ─── App-level JWT ───────────────────────────────────────────────────────────

/**
 * Generate a short-lived JWT for authenticating as the GitHub App itself.
 * Valid for 10 minutes (GitHub's maximum).
 *
 * Requires GITHUB_APP_ID and GITHUB_PRIVATE_KEY env vars.
 */
export function generateAppJwt(): string {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_PRIVATE_KEY;

  if (!appId || !privateKey) {
    throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY are required");
  }

  const now = Math.floor(Date.now() / 1000);

  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
  ).toString("base64url");

  const signature = crypto
    .createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(privateKey, "base64url");

  return `${header}.${payload}.${signature}`;
}

// ─── App-level API request ───────────────────────────────────────────────────

/**
 * Make an authenticated request as the GitHub App (not as an installation).
 * Used for endpoints like creating installation tokens.
 */
export async function appFetch<T = unknown>(
  url: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const jwt = generateAppJwt();
  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await res.json() as T & { message?: string };
  if (!res.ok) {
    throw new Error(`GitHub App API error (${res.status}): ${data.message ?? "Unknown"}`);
  }
  return data;
}

// ─── Installation ID lookup ──────────────────────────────────────────────────

/**
 * Resolve the GitHub App installation ID for a given user + owner.
 * Checks cache first, then the database.
 */
export async function getInstallationId(
  userId: string,
  owner: string,
): Promise<number | null> {
  if (!owner) return null;

  const cacheKey = `inst:${userId}:${owner.toLowerCase()}`;
  const cached = tokenCache.get(cacheKey);
  if (cached) return Number(cached);

  const row = await repos.gitInstallation.findByOwner(userId, owner);
  if (!row) return null;

  tokenCache.set(cacheKey, String(row.installationId), 50 * 60);
  return row.installationId;
}

// ─── Installation access token ───────────────────────────────────────────────

/**
 * Get an installation access token (scoped to the installed repos).
 * Tokens are cached for 50 minutes (GitHub tokens expire after 60).
 */
export async function getInstallationToken(
  userId: string,
  owner: string,
  installationId?: number,
): Promise<string | null> {
  if (!installationId) {
    installationId = (await getInstallationId(userId, owner)) ?? undefined;
  }
  if (!installationId) return null;

  const cacheKey = `instToken:${userId}:${owner}:${installationId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached) return cached;

  const data = await appFetch<{ token: string }>(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    { method: "POST" },
  );

  tokenCache.set(cacheKey, data.token, 50 * 60);
  return data.token;
}

// ─── User OAuth token ────────────────────────────────────────────────────────

/**
 * Get the user's personal GitHub OAuth token stored by Better Auth.
 * Used for user-scoped operations (listing their orgs, etc.).
 */
export async function getUserToken(userId: string): Promise<string | null> {
  const account = await repos.account.findByProvider(userId, "github");
  return account?.accessToken ?? null;
}

// ─── Unified token resolver ──────────────────────────────────────────────────

export interface TokenOptions {
  userId: string;
  owner?: string;
  installationId?: number;
  /** Use the user's personal OAuth token instead of installation token */
  useUserToken?: boolean;
}

/**
 * Resolve the best available token for a GitHub API request.
 *
 * Priority:
 *   1. User token (if useUserToken=true, e.g. for /user/* endpoints)
 *   2. Installation token (for repo-scoped operations)
 *   3. User token as fallback (when no owner is specified)
 */
export async function resolveToken(opts: TokenOptions): Promise<string | null> {
  if (opts.useUserToken) {
    return getUserToken(opts.userId);
  }
  if (opts.owner) {
    const instToken = await getInstallationToken(opts.userId, opts.owner, opts.installationId);
    if (instToken) return instToken;
  }
  /* Fallback to user OAuth token if no installation token found */
  return getUserToken(opts.userId);
}

// ─── GitHub API fetch helper ─────────────────────────────────────────────────

export interface GitHubFetchOptions {
  userId: string;
  url: string;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  owner?: string;
  installationId?: number;
  params?: Record<string, unknown>;
  useUserToken?: boolean;
  headers?: Record<string, string>;
}

/**
 * Make an authenticated GitHub API request on behalf of a user.
 *
 * Automatically resolves the correct token (installation or user OAuth).
 * Appends query params for GET requests, sends JSON body for others.
 */
export async function githubFetch<T = unknown>(opts: GitHubFetchOptions): Promise<T> {
  const method = opts.method ?? "GET";

  const token = await resolveToken({
    userId: opts.userId,
    owner: opts.owner,
    installationId: opts.installationId,
    useUserToken: opts.useUserToken,
  });

  if (!token) {
    throw new Error("No GitHub access token available. Please connect your GitHub account.");
  }

  let url = opts.url;
  if (method === "GET" && opts.params) {
    const entries: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.params)) {
      entries[k] = String(v);
    }
    const qs = new URLSearchParams(entries).toString();
    url = qs ? `${url}?${qs}` : url;
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers ?? {}),
    },
    body: method !== "GET" ? JSON.stringify(opts.params ?? {}) : undefined,
  });

  /* Some endpoints return 204 No Content */
  if (res.status === 204) {
    return { success: true } as T;
  }

  const data = (await res.json()) as T & { message?: string };
  if (!res.ok) {
    throw new Error(`GitHub API error (${res.status}): ${(data as { message?: string }).message ?? "Unknown"}`);
  }
  return data;
}

// ─── User status helpers ─────────────────────────────────────────────────────

/**
 * Check if the user is connected to GitHub and return their profile.
 */
export async function getUserStatus(userId: string) {
  const token = await getUserToken(userId);
  if (!token) {
    return { connected: false as const };
  }

  try {
    const user = await githubFetch<{ login: string; id: number; avatar_url: string }>({
      userId,
      url: "https://api.github.com/user",
      useUserToken: true,
    });
    return { connected: true as const, ...user };
  } catch {
    return { connected: false as const };
  }
}

/**
 * Get all installations that the user has access to.
 * Returns empty array if the user has no GitHub OAuth token.
 */
export async function getUserInstallations(userId: string): Promise<GitHubInstallation[]> {
  const token = await getUserToken(userId);
  if (!token) return [];

  try {
    const data = await githubFetch<{ installations: GitHubInstallation[] }>({
      userId,
      url: "https://api.github.com/user/installations",
      useUserToken: true,
    });

    /* Cross-reference with our DB to only return installations the user owns */
    const dbInstallations = await repos.gitInstallation.listByUser(userId);
    const dbIds = new Set(dbInstallations.map((i) => i.installationId));

    return (data.installations ?? []).filter((i) => dbIds.has(i.id));
  } catch {
    return [];
  }
}

/**
 * Map raw installation data to a clean account summary.
 */
export function mapAccounts(installations: GitHubInstallation[]): MappedAccount[] {
  return installations.map((i) => ({
    login: i.account.login,
    id: i.account.id,
    avatar_url: i.account.avatar_url,
    type: i.account.type,
  }));
}

// ─── Connect / Disconnect ────────────────────────────────────────────────────

/** Whether we're running in cloud mode (GitHub App installation flow). */
export function isCloudMode(): boolean {
  return env.CLOUD_MODE || env.DEPLOY_MODE === "cloud";
}

/**
 * Get the GitHub App installation URL (cloud mode).
 */
export function getInstallUrl(): string {
  const appSlug = env.GITHUB_APP_SLUG ?? "openship";
  return `https://github.com/apps/${appSlug}/installations/new`;
}

/**
 * Disconnect a user from GitHub — removes all installations and invalidates cache.
 */
export async function disconnectUser(userId: string): Promise<void> {
  await repos.gitInstallation.removeAllForUser(userId);
  tokenCache.invalidateBySubstring(userId);
}
