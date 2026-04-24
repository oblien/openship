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
 * In local / desktop mode, token resolution falls back to the machine's
 * `gh` CLI credentials — see `github.local-auth.ts`.
 *
 * Token caching uses a simple in-memory Map with TTL to avoid hitting
 * GitHub's token endpoint on every request.
 */

import crypto from "crypto";
import { repos } from "@repo/db";
import { env } from "../../config/env";
import { TtlCache } from "../../lib/cache";
import { getLocalGhToken } from "./github.local-auth";
import type { GitHubInstallation, MappedAccount } from "./github.types";

// ─── Token cache ─────────────────────────────────────────────────────────────

const tokenCache = new TtlCache<string>({ maxSize: 5_000, sweepIntervalMs: 60_000 });

// ─── App-level JWT ───────────────────────────────────────────────────────────

/** Cached decoded PEM — decoded once from base64 on first use. */
let _cachedPrivateKey: string | null = null;

/**
 * Resolve the GitHub App private key from environment.
 * Supports two formats:
 *   - GITHUB_PRIVATE_KEY       — raw PEM string (multi-line)
 *   - GITHUB_PRIVATE_KEY_BASE64 — base64-encoded PEM (single env var line)
 * Decoded value is cached in memory.
 */
function resolvePrivateKey(): string {
  if (_cachedPrivateKey) return _cachedPrivateKey;

  if (env.GITHUB_PRIVATE_KEY) {
    _cachedPrivateKey = env.GITHUB_PRIVATE_KEY;
    return _cachedPrivateKey;
  }

  if (env.GITHUB_PRIVATE_KEY_BASE64) {
    _cachedPrivateKey = Buffer.from(env.GITHUB_PRIVATE_KEY_BASE64, "base64").toString("utf-8");
    return _cachedPrivateKey;
  }

  throw new Error("GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_BASE64 is required");
}

/**
 * Generate a short-lived JWT for authenticating as the GitHub App itself.
 * Valid for 10 minutes (GitHub's maximum).
 *
 * Requires GITHUB_APP_ID and a private key env var.
 */
export function generateAppJwt(): string {
  const appId = env.GITHUB_APP_ID;
  if (!appId) {
    throw new Error("GITHUB_APP_ID is required");
  }

  const privateKey = resolvePrivateKey();
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
 * Dispatches by GITHUB_AUTH_MODE:
 *   - "app"   → installation token → user OAuth fallback
 *   - "oauth" → user OAuth token only
 *   - "cli"   → user OAuth → gh CLI fallback
 *   - "token" → static GITHUB_TOKEN env var
 */
export async function resolveToken(opts: TokenOptions): Promise<string | null> {
  const mode = getGitHubAuthMode();

  switch (mode) {
    case "token":
      return env.GITHUB_TOKEN ?? null;

    case "app": {
      if (opts.useUserToken) return getUserToken(opts.userId);
      if (opts.owner) {
        const instToken = await getInstallationToken(opts.userId, opts.owner, opts.installationId);
        if (instToken) return instToken;
      }
      return getUserToken(opts.userId);
    }

    case "oauth":
      return getUserToken(opts.userId);

    case "cli": {
      const userToken = await getUserToken(opts.userId);
      if (userToken) return userToken;
      return getLocalGhToken();
    }
  }
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
 *
 * Token source depends on GITHUB_AUTH_MODE:
 *   - "app" / "oauth" → user OAuth token
 *   - "cli"           → OAuth first, then gh CLI fallback
 *   - "token"         → static GITHUB_TOKEN env var
 */
export async function getUserStatus(userId: string) {
  const mode = getGitHubAuthMode();
  let token: string | null = null;
  let tokenSource: GitHubAuthMode = mode;

  switch (mode) {
    case "token":
      token = env.GITHUB_TOKEN ?? null;
      break;
    case "cli": {
      token = await getUserToken(userId);
      if (token) { tokenSource = "oauth"; break; }
      token = await getLocalGhToken();
      tokenSource = "cli";
      break;
    }
    default: // "app" | "oauth"
      token = await getUserToken(userId);
      tokenSource = "oauth";
      break;
  }

  if (!token) {
    return { connected: false as const, tokenSource: null };
  }

  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return { connected: false as const, tokenSource: null };
    const user = (await res.json()) as { login: string; id: number; avatar_url: string };
    return { connected: true as const, tokenSource, ...user };
  } catch {
    return { connected: false as const, tokenSource: null };
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

// ─── GitHub auth mode ─────────────────────────────────────────────────────

export type GitHubAuthMode = "app" | "oauth" | "cli" | "token";

/**
 * Resolve the effective GitHub auth mode.
 *
 * If `GITHUB_AUTH_MODE=auto` (default), inferred from CLOUD_MODE:
 *   - CLOUD_MODE=true  → "app"  (GitHub App installation tokens)
 *   - CLOUD_MODE=false → "cli"  (gh CLI / device flow)
 *
 * DEPLOY_MODE is intentionally not checked here — a local dashboard
 * deploying to Oblien (DEPLOY_MODE=cloud) should still use CLI auth.
 *
 * Explicit values ("app", "oauth", "cli", "token") are used as-is.
 */
export function getGitHubAuthMode(): GitHubAuthMode {
  const explicit = env.GITHUB_AUTH_MODE;
  if (explicit !== "auto") return explicit;

  if (env.CLOUD_MODE) return "app";
  return "cli";
}

/** Shorthand — true when the resolved auth mode is "app" (GitHub App). */
export function isCloudMode(): boolean {
  return getGitHubAuthMode() === "app";
}

/**
 * Get the GitHub App installation URL (cloud mode).
 */
export function getInstallUrl(): string {
  const appSlug = env.GITHUB_APP_SLUG ?? "openship-io";
  return `https://github.com/apps/${appSlug}/installations/new`;
}

/**
 * Disconnect a user from GitHub — removes all installations and invalidates cache.
 */
export async function disconnectUser(userId: string): Promise<void> {
  await repos.account.unlinkProvider(userId, "github");
  await repos.gitInstallation.removeAllForUser(userId);
  tokenCache.invalidateBySubstring(userId);
}
