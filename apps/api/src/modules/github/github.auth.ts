/**
 * GitHub auth - handles GitHub App JWT, installation tokens, and user tokens.
 *
 * This module is the single source of truth for authenticating with the GitHub API.
 * It manages:
 *   - App-level JWT generation (for GitHub App endpoints)
 *   - Installation access tokens (for repo-scoped operations)
 *   - User OAuth tokens (for user-scoped operations, via Better Auth)
 *   - A thin `githubFetch` helper that picks the right auth automatically
 *
 * In local / desktop mode, token resolution falls back to the machine's
 * `gh` CLI credentials - see `github.local-auth.ts`.
 *
 * Token caching uses a simple in-memory Map with TTL to avoid hitting
 * GitHub's token endpoint on every request.
 */

import crypto from "crypto";
import { repos, db, schema, eq, and } from "@repo/db";
import { APIError } from "better-auth/api";
import { safeErrorMessage } from "@repo/core";
import { env } from "../../config/env";
import { auth } from "../../lib/auth";
import { cacheStore } from "../../lib/cache-store";
// gh-CLI (github.local-auth) is imported DYNAMICALLY at its two self-hosted
// call sites (getUserStatus "cli" branch, getGitHubConnectionState gh probe)
// so the gh module never loads in CLOUD_MODE (the SaaS). See those sites.
import { ghFetch, ghFetchPublic } from "./github.http";
import { mapAccounts } from "./sources/mappers";
import type { RequestContext } from "../../lib/request-context";
import { resolveOrgOwner } from "../../lib/org-actor";
import type {
  GitHubConnectionState,
  GitHubInstallation,
  MappedAccount,
} from "./github.types";

// ─── Token cache ─────────────────────────────────────────────────────────────

/**
 * Cache TTL for installation IDs (NOT for installation access tokens —
 * those carry their own absolute expiry inside the cached envelope, see
 * `CachedInstallationToken` below).
 *
 * GitHub installation access tokens expire 60 minutes after they're
 * minted. The installation-id lookup itself doesn't expire on GitHub's
 * side — we just refresh it every 45 minutes to absorb membership
 * churn.
 */
const GITHUB_TOKEN_CACHE_TTL_SECONDS = 45 * 60;

/**
 * Safety margin we subtract from GitHub's reported `expires_at` before
 * declaring a cached installation token reusable. 30 s absorbs the
 * worst-case clock skew between this host and api.github.com, plus the
 * round-trip we'd otherwise spend trying to use an already-expired
 * token. (60 min mint window − 30 s = ~3570 s of usable life.)
 */
const GITHUB_TOKEN_EXPIRY_SAFETY_SECONDS = 30;

/**
 * Cached installation-token envelope. We persist both the bearer token
 * AND GitHub's authoritative `expires_at` so a long-lived cache (a
 * process restart that survives a Redis cacheStore) cannot serve an
 * already-expired token. Prior to HIGH #4 the cache TTL was the ONLY
 * expiry; if cacheStore promoted the entry past 60 minutes (e.g.
 * external store with its own TTL semantics), we'd hand out a dead
 * token and every downstream API call would 401.
 */
interface CachedInstallationToken {
  token: string;
  /** ISO8601, mirrored from the GitHub /access_tokens response. */
  expiresAt: string;
}

function isCachedTokenStillFresh(envelope: CachedInstallationToken): boolean {
  const expiresMs = Date.parse(envelope.expiresAt);
  if (!Number.isFinite(expiresMs)) return false;
  const cutoffMs = Date.now() + GITHUB_TOKEN_EXPIRY_SAFETY_SECONDS * 1000;
  return cutoffMs < expiresMs;
}

function encodeTokenEnvelope(envelope: CachedInstallationToken): string {
  return JSON.stringify(envelope);
}

function decodeTokenEnvelope(raw: string): CachedInstallationToken | null {
  try {
    const parsed = JSON.parse(raw) as Partial<CachedInstallationToken>;
    if (typeof parsed.token === "string" && typeof parsed.expiresAt === "string") {
      return { token: parsed.token, expiresAt: parsed.expiresAt };
    }
    return null;
  } catch {
    // Legacy cache entry (plain token string from before HIGH #4). Treat
    // as stale so the next caller re-mints — strictly better than
    // serving a token without a verifiable expiry.
    return null;
  }
}

/**
 * Cache key shapes — all owned by this module. The shape matters for
 * invalidation:
 *   - `inst:user:${userId}:`             — per-user installation-ID lookup
 *   - `instToken:local:user:${userId}:`  — per-user local-mint fallback
 *                                          (only when no org context)
 *   - `inst:org:${organizationId}:`      — org-shared installation-ID lookup
 *   - `instToken:local:org:${organizationId}:` — org-shared local-mint
 *   - `instToken:cloud:${organizationId}:`     — org-shared cloud-proxied mint
 *
 * Prefix-based invalidation (below) is the ONLY safe way to clear keys
 * containing a userId — substring matching would clobber unrelated
 * org keys whose IDs happen to share characters with the userId.
 */
const GH_TOKEN_NS = "gh-tokens";

/**
 * Clear every cached entry that belongs to this user — both the
 * user-scoped installation-ID lookup AND the user-scoped installation
 * token mints. Called on OAuth disconnect, webhook installation
 * changes initiated by the user, and the sync of the user's local
 * installations table.
 *
 * Does NOT touch org-scoped entries; for that, see
 * `invalidateOrgGitHubCache`. The two are kept separate so a
 * teammate's OAuth disconnect doesn't blow away the whole org's
 * cached installations.
 */
export async function invalidateUserGitHubCache(userId: string): Promise<void> {
  const store = await cacheStore<string>(GH_TOKEN_NS, { maxSize: 5_000 });
  await store.invalidateByPrefix(`inst:user:${userId}:`);
  await store.invalidateByPrefix(`instToken:local:user:${userId}:`);
}

/**
 * Clear every cached entry scoped to an organization — used when an
 * installation belonging to a team changes (install/uninstall/suspend
 * webhook). All members of the org share these entries, so the whole
 * prefix is swept atomically.
 */
export async function invalidateOrgGitHubCache(organizationId: string): Promise<void> {
  const store = await cacheStore<string>(GH_TOKEN_NS, { maxSize: 5_000 });
  await store.invalidateByPrefix(`inst:org:${organizationId}:`);
  await store.invalidateByPrefix(`instToken:local:org:${organizationId}:`);
  await store.invalidateByPrefix(`instToken:cloud:${organizationId}:`);
}

// ─── App-level JWT ───────────────────────────────────────────────────────────

/**
 * Decoded GitHub App private key, resolved once at module load.
 * Supports two formats:
 *   - GITHUB_PRIVATE_KEY        - raw PEM string (multi-line)
 *   - GITHUB_PRIVATE_KEY_BASE64 - base64-encoded PEM (single env var line)
 * Null when neither is set — `generateAppJwt` throws on use.
 */
const PRIVATE_KEY: string | null = env.GITHUB_PRIVATE_KEY
  ?? (env.GITHUB_PRIVATE_KEY_BASE64
    ? Buffer.from(env.GITHUB_PRIVATE_KEY_BASE64, "base64").toString("utf-8")
    : null);

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

  if (!PRIVATE_KEY) {
    throw new Error("GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_BASE64 is required");
  }

  const now = Math.floor(Date.now() / 1000);

  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
  ).toString("base64url");

  const signature = crypto
    .createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(PRIVATE_KEY, "base64url");

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
 *
 * Takes a RequestContext so cloud-app mode can look up the canonical
 * org-scoped install state via `ctx.organizationId` — no more
 * memberships[0] guessing. When the resolved mode isn't cloud-app, the
 * lookup still falls back to the per-user row (e.g. self-hosted "app"
 * mode where the webhook fires locally).
 */
export async function getInstallationId(
  ctx: RequestContext,
  owner: string,
): Promise<number | null> {
  if (!owner) return null;
  const userId = ctx.userId;

  // Cloud-app mode: ALWAYS ask SaaS. api.openship.io is the canonical
  // store — the GitHub App webhook fires to SaaS, not to us, so its
  // record is authoritative. Skip the local DB entirely; a stale row
  // would lie for up to 50min after a user uninstalls / re-installs.
  // tokenCache provides short-term memoization (50min TTL) so we don't
  // hammer SaaS on every preflight.
  const mode = await resolveGitHubAuthMode(ctx).catch(() => "none" as const);
  if (mode === "cloud-app") {
    // ctx.organizationId is the canonical answer — permission.assert
    // has already rebound it to the resource-scoped org when this is a
    // resource-bound route, so we never need to guess memberships[0].
    const organizationId = ctx.organizationId;
    const cacheKey = `inst:org:${organizationId}:${owner.toLowerCase()}`;
    const store = await cacheStore<string>(GH_TOKEN_NS, { maxSize: 5_000 });
    const cached = await store.get(cacheKey);
    if (cached) return Number(cached);
    const { cloudClient } = await import("../../lib/cloud/client");
    const list = await cloudClient({ organizationId }).github.installations().catch(() => null);
    if (!list) return null;
    const match = list.find(
      (entry) => entry.login.toLowerCase() === owner.toLowerCase(),
    );
    if (!match) return null;
    await store.set(cacheKey, String(match.id), GITHUB_TOKEN_CACHE_TTL_SECONDS);
    return match.id;
  }

  // Self-hosted "app" mode below — cache by user since the local DB
  // installations are per-user rows.
  const cacheKey = `inst:user:${userId}:${owner.toLowerCase()}`;
  const store = await cacheStore<string>(GH_TOKEN_NS, { maxSize: 5_000 });
  const cached = await store.get(cacheKey);
  if (cached) return Number(cached);

  // Self-hosted "app" mode — local DB is the only store, since the
  // webhook fired here.
  const row = await repos.gitInstallation.findByOwner(userId, owner);
  if (!row) return null;

  await store.set(cacheKey, String(row.installationId), GITHUB_TOKEN_CACHE_TTL_SECONDS);
  return row.installationId;
}

/**
 * Resolve the GitHub App installation ID for a given organization + owner.
 *
 * The preferred multi-user lookup path. Multiple members of the same org
 * share access to the org's installations — scoping by `organizationId`
 * survives membership churn (members leaving) and lets any teammate use
 * an installation that another teammate originally connected.
 */
export async function getInstallationIdByOrg(
  organizationId: string,
  owner: string,
): Promise<number | null> {
  if (!organizationId || !owner) return null;

  const cacheKey = `inst:org:${organizationId}:${owner.toLowerCase()}`;
  const store = await cacheStore<string>(GH_TOKEN_NS, { maxSize: 5_000 });
  const cached = await store.get(cacheKey);
  if (cached) return Number(cached);

  // Cloud-app mode: SaaS is the source of truth. cloudGithubInstallations
  // resolves the org owner internally and returns the team's
  // installations in one round-trip — no member iteration needed.
  //
  // Mode resolution here does NOT use ctx — this function is an
  // org-scoped lookup used by background paths (token.ts preflight,
  // billing webhooks) that don't carry a per-request context. The
  // org owner's cloud-session is the right scope: if the owner is
  // cloud-connected the team's installs live on SaaS.
  const ownerMember = await resolveOrgOwner(organizationId).catch(() => null);
  const mode = await resolveAuthModeForOrgOwner(ownerMember?.userId);

  if (mode === "cloud-app") {
    const { cloudClient } = await import("../../lib/cloud/client");
    const list = await cloudClient({ organizationId }).github.installations().catch(() => null);
    if (!list) return null;
    const match = list.find(
      (entry) => entry.login.toLowerCase() === owner.toLowerCase(),
    );
    if (!match) return null;
    await store.set(cacheKey, String(match.id), GITHUB_TOKEN_CACHE_TTL_SECONDS);
    return match.id;
  }

  // Self-hosted "app" mode. The webhook fires to us, so local DB is
  // the source of truth.
  const row = await repos.gitInstallation.findByOrgAndOwner(organizationId, owner);
  if (!row) return null;

  await store.set(cacheKey, String(row.installationId), GITHUB_TOKEN_CACHE_TTL_SECONDS);
  return row.installationId;
}

// ─── Installation access token ───────────────────────────────────────────────

/**
 * Get an installation access token (scoped to the installed repos).
 *
 * Tokens are cached for 50 minutes (GitHub tokens expire after 60).
 *
 * Path branches on the user's resolved auth mode:
 *   - "app"       → local JWT signing + api.github.com call (cloud-mode only)
 *   - "cloud-app" → cloud-client proxy to api.openship.io
 *
 * Other modes (cli/oauth/token) don't use installation tokens.
 *
 * Resolution order for the installation row when `installationId` is not
 * provided:
 *   1. `organizationId` + owner → preferred multi-user path.
 *   2. `userId` + owner         → single-user fallback for callers that
 *                                 don't have org context.
 */
export async function getInstallationToken(
  ctx: RequestContext,
  owner: string,
  installationId?: number,
  opts: {
    /**
     * Narrow the minted token to these repositories (bare names, as GitHub's
     * `POST /app/installations/:id/access_tokens` expects — `charts`, not
     * `hydralerne/charts`).
     *
     * Without this an installation token covers EVERY repo the installation
     * reaches, so handing one to a caller granted a single repo would give them a
     * credential far broader than their grant. Callers acting on one repo should
     * always pass it.
     */
    repositories?: string[];
  } = {},
): Promise<string | null> {
  const userId = ctx.userId;
  const organizationId = ctx.organizationId;
  const mode = await resolveGitHubAuthMode(ctx);

  // Narrowed and broad tokens MUST NOT share a cache entry: a broad token served
  // from the narrow key would silently over-grant, and a narrow token served from
  // the broad key would break unrelated callers. Sorted + lowercased so the same
  // repo set always produces the same key.
  const repoScope = opts.repositories?.length
    ? `:repos:${[...opts.repositories].map((r) => r.toLowerCase()).sort().join(",")}`
    : "";

  if (mode === "cloud-app") {
    // Proxy through cloud. ctx.organizationId is the only source of
    // truth — no more memberships[0] fallback that could leak tokens
    // across the cache between users whose synthesized ids collide
    // with real org ids.
    const orgId = organizationId;
    const cacheKey = `instToken:cloud:${orgId}:${owner}${repoScope}`;
    const store = await cacheStore<string>(GH_TOKEN_NS, { maxSize: 5_000 });
    const cachedRaw = await store.get(cacheKey);
    if (cachedRaw) {
      const cached = decodeTokenEnvelope(cachedRaw);
      // HIGH #4 — honor GitHub's authoritative expiry. A persistent
      // cacheStore (Redis with its own TTL) could otherwise resurrect
      // an envelope past the 60-minute mint window.
      if (cached && isCachedTokenStillFresh(cached)) return cached.token;
    }

    const { cloudClient } = await import("../../lib/cloud/client");
    // installationId is intentionally not passed — the SaaS endpoint resolves
    // the installation from `owner`, and the unified client signature dropped
    // the parameter.
    void installationId;
    // The SaaS endpoint already accepts a repo list — forward it so a cloud-mode
    // instance narrows exactly like a self-hosted one.
    const minted = await cloudClient({ organizationId: orgId }).github.installationToken(
      owner,
      opts.repositories?.length ? opts.repositories : undefined,
    );
    if (!minted?.token) return null;
    const envelope: CachedInstallationToken = {
      token: minted.token,
      expiresAt:
        // Cloud proxy may not echo the GitHub expires_at; if absent,
        // synthesize one 55 minutes out — still under the 60-minute
        // mint window so the cache will refresh before it dies.
        ((minted as { expiresAt?: string }).expiresAt) ??
        new Date(Date.now() + 55 * 60 * 1000).toISOString(),
    };
    await store.set(cacheKey, encodeTokenEnvelope(envelope), GITHUB_TOKEN_CACHE_TTL_SECONDS);
    return envelope.token;
  }

  // Local-mint path (cloud-mode SaaS, or explicit GITHUB_AUTH_MODE=app).
  // Prefer the org-scoped row when an organizationId is in play, then
  // fall back to the per-user row.
  if (!installationId) {
    installationId =
      (await getInstallationIdByOrg(organizationId, owner)) ?? undefined;
    if (!installationId) {
      installationId = (await getInstallationId(ctx, owner)) ?? undefined;
    }
  }
  if (!installationId) return null;

  // The installation token from GitHub is keyed purely on the
  // installationId (an org-wide GitHub resource), so every member of
  // the same org should share one cache entry. Key by org so teammates
  // hit the same mint result.
  const cacheKey = `instToken:local:org:${organizationId}:${owner}:${installationId}${repoScope}`;
  const store = await cacheStore<string>(GH_TOKEN_NS, { maxSize: 5_000 });
  const cachedRaw = await store.get(cacheKey);
  if (cachedRaw) {
    const cached = decodeTokenEnvelope(cachedRaw);
    if (cached && isCachedTokenStillFresh(cached)) return cached.token;
  }

  try {
    const data = await appFetch<{ token: string; expires_at: string }>(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        ...(opts.repositories?.length ? { body: { repositories: opts.repositories } } : {}),
      },
    );
    const envelope: CachedInstallationToken = {
      token: data.token,
      // GitHub's `expires_at` is the SOURCE OF TRUTH for token lifetime.
      // Fall back to a 55-minute window only if the field is missing
      // (shouldn't happen on api.github.com, but defends against
      // GitHub Enterprise variants and test fixtures).
      expiresAt:
        data.expires_at ??
        new Date(Date.now() + 55 * 60 * 1000).toISOString(),
    };
    await store.set(cacheKey, encodeTokenEnvelope(envelope), GITHUB_TOKEN_CACHE_TTL_SECONDS);
    return envelope.token;
  } catch (err) {
    // Cascade MEDIUM — when GitHub returns 404 on /app/installations/:id
    // the installation has been removed on github.com but our local
    // gitInstallation row still points at the dead id. Drop the stale
    // row so the next resolution falls through to a fresh App-side
    // lookup (or to OAuth) instead of refusing the same dead id
    // forever.
    const message = (err as Error).message ?? "";
    if (/\(404\)/.test(message) || /Not Found/i.test(message)) {
      await dropStaleInstallationRow(userId, owner, installationId).catch(() => {
        /* best-effort */
      });
    }
    throw err;
  }
}

/**
 * Drop a stale `gitInstallation` row when GitHub reports the installation
 * id no longer exists (HTTP 404 on /app/installations/:id). Without this,
 * every future call from this user/org for the same owner would hit the
 * same dead id and re-throw. We invalidate caches afterwards so a fresh
 * lookup re-resolves via the user's OAuth /installations list.
 */
async function dropStaleInstallationRow(
  userId: string,
  owner: string,
  installationId: number,
): Promise<void> {
  const row = await repos.gitInstallation.findByOwner(userId, owner).catch(() => null);
  if (!row || row.installationId !== installationId) return;
  await repos.gitInstallation.removeByInstallationId(userId, installationId);
  await invalidateUserGitHubCache(userId);
  if (row.organizationId) {
    await invalidateOrgGitHubCache(row.organizationId);
  }
  console.warn(
    `[GitHub] dropped stale gitInstallation row for ${owner} (installationId=${installationId}) — GitHub returned 404`,
  );
}

// ─── User OAuth token ────────────────────────────────────────────────────────

/**
 * Get the user's personal GitHub OAuth token stored by Better Auth.
 * Used for user-scoped operations (listing their orgs, etc.).
 */
export async function getUserToken(userId: string): Promise<string | null> {
  try {
    const tokens = await auth.api.getAccessToken({
      body: {
        providerId: "github",
        userId,
      },
    });

    return tokens.accessToken ?? null;
  } catch (error) {
    if (error instanceof APIError) {
      return null;
    }

    throw error;
  }
}

// ─── GitHub API fetch helper ─────────────────────────────────────────────────

export interface GitHubFetchOptions {
  /** Caller's request context. Carries userId + organizationId for the
   *  underlying `tokenFor` dispatcher (PAT → installation → OAuth chain).
   *  See `github.token.ts` for the resolution order. */
  ctx: RequestContext;
  url: string;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  owner?: string;
  installationId?: number;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/**
 * Make an authenticated GitHub API request on behalf of a user.
 *
 * Token source follows FLOW × MODE:
 *   - A local READ (GET) goes gh-FIRST when a local gh token exists. A GET on
 *     the API host is a local read — the response never leaves this host — so
 *     it uses the gh token DIRECTLY, ungated, exactly like the gh-CLI listing
 *     path. tokenFor's gh-cli OPERATOR gate (HIGH #7) only guards token-
 *     SHIPPING to remote build workers, NOT local reads, so we deliberately
 *     bypass it here. getLocalGhToken self-guards to null in CLOUD_MODE, so on
 *     the SaaS this falls straight through to tokenFor (the App).
 *   - Everything else (writes: check-runs/webhooks, or no local gh) resolves
 *     via `tokenFor(ctx, "local", ...)` — PAT → App installation → OAuth.
 *     Check-runs MUST be the App, so writes never go gh-first.
 *
 * Appends query params for GET requests, sends JSON body for others.
 */
export async function githubFetch<T = unknown>(opts: GitHubFetchOptions): Promise<T> {
  const method = opts.method ?? "GET";

  // gh-first for local reads.
  if (method === "GET") {
    const { getLocalGhToken } = await import("./github.local-auth");
    const ghToken = await getLocalGhToken();
    if (ghToken) {
      return ghFetch<T>(ghToken, {
        url: opts.url,
        method,
        params: opts.params,
        headers: opts.headers,
      });
    }
  }

  const { tokenFor } = await import("./github.token");
  const result = await tokenFor(opts.ctx, "local", {
    owner: opts.owner,
    installationId: opts.installationId,
  });
  const token = result?.token ?? null;

  if (!token) {
    // No credential resolved. A PUBLIC github.com repo still answers the REST
    // API unauthenticated, so try that before demanding a connection — this is
    // what lets a public repo URL be prepared/deployed with no GitHub link.
    // A private/missing repo 404s to anonymous callers → null → fall through to
    // the connect-account error (which for a private repo is the right guidance).
    if (method === "GET") {
      const publicData = await ghFetchPublic<T>({
        url: opts.url,
        params: opts.params,
        headers: opts.headers,
      });
      if (publicData !== null) return publicData;
    }
    throw new Error("No GitHub access token available. Please connect your GitHub account.");
  }

  // tokenFor owns "which token + is it authorized"; the wire mechanics
  // (headers, querystring, 204, error shape) live in the shared ghFetch
  // primitive so the gh-CLI listing helpers and this path can't drift.
  return ghFetch<T>(token, {
    url: opts.url,
    method,
    params: opts.params,
    headers: opts.headers,
  });
}

// ─── User status helpers ─────────────────────────────────────────────────────

/**
 * Check if the user is connected to GitHub and return their profile.
 *
 * Path branches on the per-user resolved auth mode:
 *   - "cloud-app" → cloud-client proxy (cloud owns the OAuth identity)
 *   - "app" / "oauth" → user OAuth token (local Better-Auth)
 *   - "cli"           → OAuth first, then gh CLI fallback
 *   - "token"         → static GITHUB_TOKEN env var
 */
export async function getUserStatus(userId: string) {
  // userId-only path — getUserStatus is called from background sync
  // (no Hono ctx) and from per-user controllers; both already operate
  // off the bare userId. Use the internal mode resolver.
  const mode = await resolveAuthModeForUserId(userId);

  // ── Cloud-app: status comes from openship.io ────────────────────────────
  if (mode === "cloud-app") {
    const { cloudClient } = await import("../../lib/cloud/client");
    const status = await cloudClient({ userId }).github.userStatus();
    if (!status?.connected) {
      // Diagnostic: the SaaS-side handler reported the user as not
      // connected. The most likely cause is that the local's
      // cloudSessionToken now resolves to a different SaaS user than
      // the one OAuth linked to (session rotated, account re-linked,
      // 401 cleanup wiped it). Log the local userId so it can be
      // correlated with the SaaS log line.
      console.log(
        `[github.auth:getUserStatus] cloud-app reports disconnected localUserId=${userId} cloudResponse=${JSON.stringify(status ?? null)}`,
      );
      return { connected: false as const, tokenSource: null };
    }
    return {
      connected: true as const,
      tokenSource: "cloud-app" as GitHubAuthMode,
      oauthConnected: true as const,
      login: status.login ?? "",
      id: status.id ?? 0,
      avatar_url: status.avatarUrl ?? "",
    };
  }

  let token: string | null = null;
  let tokenSource: GitHubAuthMode = mode;

  switch (mode) {
    case "token":
      token = env.GITHUB_TOKEN ?? null;
      break;
    case "cli": {
      token = await getUserToken(userId);
      if (token) { tokenSource = "oauth"; break; }
      // gh CLI fallback - only if the user hasn't explicitly disconnected it.
      // Otherwise a user who clicked "Disconnect" from cli mode would silently
      // stay connected because gh is still authed on the host.
      const { isGithubCliDisabled } = await import("../settings/settings.service");
      const cliDisabled = await isGithubCliDisabled(userId);
      if (cliDisabled) break;
      // Dynamic import: the gh module loads ONLY on this self-hosted "cli"
      // branch — never on the SaaS (CLOUD_MODE resolves mode "app", never "cli").
      const { getLocalGhToken } = await import("./github.local-auth");
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
    if (!res.ok) {
      return { connected: false as const, tokenSource: null };
    }
    const user = (await res.json()) as { login: string; id: number; avatar_url: string };
    return { connected: true as const, tokenSource, oauthConnected: true as const, ...user };
  } catch {
    return { connected: false as const, tokenSource: null };
  }
}

/**
 * Wrap `getUserStatus` with a diagnostic DB-row count on the disconnected
 * branch. Extracted from cloud-saas.controller's githubUserStatus handler
 * so the diagnostic lookup stays in sync with the auth resolution above
 * for every caller — the controller used to ad-hoc the same query.
 *
 * Distinguishes "wrong-user/stale-cloud-session" (no row in DB) from
 * "row exists but token refresh failed" (token fetch null).
 */
export async function getUserStatusWithDiagnostics(
  userId: string,
): Promise<
  | { connected: false; githubAccountRowsForUser: number }
  | { connected: true; login: string; avatar_url: string; id: string }
> {
  const status = await getUserStatus(userId);
  if (!status.connected) {
    let githubRowCount = -1;
    try {
      const rows = await db
        .select({ id: schema.account.id })
        .from(schema.account)
        .where(
          and(
            eq(schema.account.userId, userId),
            eq(schema.account.providerId, "github"),
          ),
        );
      githubRowCount = rows.length;
    } catch (err) {
      console.log(
        `[cloud-saas:githubUserStatus] account lookup failed: ${safeErrorMessage(err)}`,
      );
    }
    return { connected: false, githubAccountRowsForUser: githubRowCount };
  }
  return {
    connected: true,
    login: status.login,
    avatar_url: status.avatar_url,
    id: String(status.id),
  };
}

// ─── Canonical connection state (single source of truth) ────────────────────

/**
 * THE canonical GitHub connection state. Every place in the codebase that
 * asks "is GitHub connected?", "which source is active?", or "is gh CLI
 * available?" reads this. There is no other answer.
 *
 * What it does NOT return:
 *   - `mode`/"saas-app"/"self-hosted" → that's `env.CLOUD_MODE` / `platform()`.
 *     The global platform mode is already the source of truth for that
 *     concept; this function doesn't duplicate it.
 *   - `tokenSource`/"app"|"oauth"|"cli"|"token"|"cloud-app" → those are
 *     INTERNAL token-strategy details of `tokenFor`. They don't belong
 *     on the wire.
 *
 * Priority for `primary`:
 *   1. Openship App when connected — safest (short-lived install tokens)
 *   2. gh CLI when available — local builds only
 *   3. null — nothing usable
 */
export async function getGitHubConnectionState(
  ctx: RequestContext,
): Promise<GitHubConnectionState> {
  const userId = ctx.userId;
  const onSelfHosted = !env.CLOUD_MODE;

  // ── Openship App side ──────────────────────────────────────────────
  // In CLOUD_MODE the App is local-signed; in self-hosted+cloud-connected
  // the App is cloud-proxied. Both flow through getUserStatus which
  // already abstracts that.
  //
  // Tolerant of failure: when the user has a stale cloud session token
  // but the cloud endpoint is unreachable (dev down, DNS, HTML 200
  // captive page, etc.), getUserStatus may throw or return false.
  // Either way, we just say "App not connected" and let gh CLI take
  // over. The library page must NEVER 500 because cloud is offline.
  let appConnected = false;
  let appLogin: string | undefined;
  let appAvatar: string | undefined;
  let hasInstallations: boolean | undefined;
  try {
    // App is connected ONLY when SaaS reports a real GitHub OAuth
    // identity for this user. The Connect flow runs OAuth on SaaS first
    // (creating a Better Auth `account` row for providerId='github'),
    // so this signal is load-bearing. Without it the install webhook
    // can't attribute installs to a SaaS user and the dashboard would
    // be lying if it showed "connected".
    const status = await getUserStatus(userId);
    appConnected = status.connected && status.tokenSource !== "cli";
    if (appConnected && status.connected) {
      appLogin = status.login;
      appAvatar = status.avatar_url;
      // Cheap "has installations" lookup — needed by the dashboard to
      // decide whether to offer "install on this org" vs "you're set".
      try {
        const installs = await getUserInstallations(ctx, status);
        hasInstallations = installs.length > 0;
      } catch {
        hasInstallations = undefined;
      }
    }
  } catch {
    // Cloud unreachable / OAuth fetch failed / network blip. App side
    // is "not connected"; gh CLI fallback below still runs.
    appConnected = false;
  }

  // ── gh CLI side ────────────────────────────────────────────────────
  // Only meaningful on self-hosted. On the SaaS the binary isn't there.
  // Single rule: `gh auth token` is valid → connected. `gh auth logout`
  // is the durable way to disconnect. We do NOT consult any per-user
  // suppression flag here — the user already said this is the rule:
  // "if gh cli logged in, use it as source of truth."
  let cliAvailable = false;
  let cliLogin: string | undefined;
  let cliAvatar: string | undefined;
  // HOW it was connected, and — when a credential is stored but GitHub refused
  // it — why. Both come from the single probe now; `method` used to need a
  // second call here, which the other two callers of the probe simply didn't
  // make, so the dashboard labelled every identity "gh CLI".
  let cliMethod: "host-cli" | "device" | "token" | undefined;
  let cliProblem: "rejected" | "unreachable" | undefined;
  let cliCheckedAt: string | undefined;
  if (onSelfHosted) {
    // Dynamic import: gh probed ONLY when self-hosted; never loaded on the SaaS.
    const { getLocalGhStatus } = await import("./github.local-auth");
    const localStatus = await getLocalGhStatus();
    cliCheckedAt = localStatus.checkedAt;
    if (localStatus.available) {
      cliAvailable = true;
      cliLogin = localStatus.login;
      cliAvatar = localStatus.avatar_url;
      cliMethod = localStatus.method;
    } else {
      cliMethod = localStatus.method ?? undefined;
      cliProblem = localStatus.problem;
    }
  }

  // ── Resolve primary per the user-stated priority ───────────────────
  const primary: GitHubConnectionState["primary"] = appConnected
    ? "openship-app"
    : cliAvailable
      ? "gh-cli"
      : null;

  return {
    sources: {
      openshipApp: {
        connected: appConnected,
        login: appLogin,
        avatarUrl: appAvatar,
        hasInstallations,
      },
      ghCli: {
        available: cliAvailable,
        login: cliLogin,
        avatarUrl: cliAvatar,
        method: cliMethod,
        problem: cliProblem,
        checkedAt: cliCheckedAt,
      },
    },
    primary,
  };
}

/**
 * Get all GitHub App installations that the user has access to.
 *
 * Path branches on per-user mode:
 *   - "cloud-app" → cloud-client proxy. Cloud owns the canonical list.
 *   - others      → user OAuth token + GitHub /user/installations call,
 *                   with local DB sync. Stored snapshot is the fallback
 *                   when the live lookup fails after OAuth was validated.
 */
export async function getUserInstallations(
  ctx: RequestContext,
  status?: { connected: boolean; id?: number },
): Promise<GitHubInstallation[]> {
  const userId = ctx.userId;
  const organizationId = ctx.organizationId;
  const mode = await resolveGitHubAuthMode(ctx);

  if (mode === "cloud-app") {
    // SaaS is the canonical source of truth — the GitHub App's webhook
    // fires to api.openship.io, not to us, so api.openship.io is the
    // only place that reliably knows about installations. We do NOT
    // cache to local DB here: a stale local row would lie for up to
    // 50 minutes after the user uninstalls or moves the App, and the
    // local row offers no benefit since every consumer ultimately
    // mints the token via the cloud proxy anyway.
    //
    // Short-term memoization is handled by `tokenCache` in the
    // per-resource lookups (getInstallationId / getInstallationIdByOrg).
    const { cloudClient } = await import("../../lib/cloud/client");
    const list = await cloudClient({ organizationId }).github.installations();
    if (!list) return [];
    return list.map((entry) => ({
      id: entry.id,
      account: {
        login: entry.login,
        id: 0,
        avatar_url: entry.avatarUrl,
        type: entry.type,
      },
      app_id: 0,
      target_type: entry.type,
      permissions: {},
      events: [],
    }));
  }

  const token = await getUserToken(userId);
  if (!token) return [];

  try {
    const userStatus = status ?? await getUserStatus(userId);
    if (!userStatus.connected) return [];

    const data = await githubFetch<{ installations: GitHubInstallation[] }>({
      ctx,
      url: "https://api.github.com/user/installations",
    });

    const installations = data.installations ?? [];

    try {
      // Foreground request — ctx.organizationId is the authoritative
      // org for this user's installs sync.
      await repos.gitInstallation.replaceForUser(
        userId,
        installations.map((installation) => ({
          organizationId,
          installationId: installation.id,
          owner: installation.account.login,
          ownerType: installation.account.type,
          providerUserId: userStatus.id ? String(userStatus.id) : undefined,
          providerOwnerId: String(installation.account.id),
          isOrg: installation.account.type === "Organization",
        })),
      );
      await invalidateUserGitHubCache(userId);
    } catch (err) {
      console.warn("[GitHub] Failed to sync installations:", (err as Error).message);
    }

    return installations;
  } catch (err) {
    // Surface the underlying error so token-type mismatches (OAuth App vs
    // GitHub App user-to-server token) and other 403s don't disappear
    // behind a silent fallback to stale DB cache. The fallback itself is
    // intentional — a stale list is better than an empty UI — but the
    // warn makes the failure mode visible the next time it fires.
    console.warn(
      "[GitHub] /user/installations failed, falling back to stored installations:",
      (err as Error).message,
    );
    return getStoredInstallations(userId);
  }
}

async function getStoredInstallations(userId: string): Promise<GitHubInstallation[]> {
  const installations = await repos.gitInstallation.listByUser(userId);
  return installations.map((installation) => ({
    id: installation.installationId,
    account: {
      login: installation.owner,
      id: storedAccountId(installation.providerOwnerId),
      avatar_url: storedAccountAvatarUrl(installation.owner, installation.providerOwnerId),
      type: installation.ownerType === "Organization" ? "Organization" : "User",
    },
    app_id: Number(env.GITHUB_APP_ID ?? 0),
    target_type: installation.ownerType,
    permissions: {},
    events: [],
  }));
}

function storedAccountId(providerOwnerId?: string | null): number {
  const id = Number(providerOwnerId);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function storedAccountAvatarUrl(owner: string, providerOwnerId?: string | null): string {
  const id = storedAccountId(providerOwnerId);
  if (id > 0) return `https://avatars.githubusercontent.com/u/${id}?v=4`;
  return `https://github.com/${encodeURIComponent(owner)}.png`;
}

// Pure mapper lives in ./sources/mappers; re-exported for back-compat.
export { mapAccounts };

// ─── Connect / Disconnect ────────────────────────────────────────────────────

// ─── GitHub auth mode ─────────────────────────────────────────────────────

export type GitHubAuthMode = "app" | "oauth" | "cli" | "token" | "cloud-app";

/**
 * Resolve the effective GitHub auth mode (SYNC — caller has no userId).
 *
 * Used by code paths that need a mode without a user context (e.g. boot-
 * time checks, batch jobs). Returns the LOCAL-only resolution:
 *   - CLOUD_MODE=true  → "app"  (this IS api.openship.io — holds App creds)
 *   - CLOUD_MODE=false → "cli"  (defaults to local gh CLI for offline use)
 *
 * Per-request callers should call `resolveGitHubAuthMode(ctx)` instead
 * — that one returns `"cloud-app"` when the user is connected to openship
 * cloud, which is the canonical self-hosted path.
 */
export function getGitHubAuthMode(): GitHubAuthMode {
  const explicit = env.GITHUB_AUTH_MODE;
  if (explicit !== "auto") return explicit as GitHubAuthMode;

  if (env.CLOUD_MODE) return "app";
  return "cli";
}

/**
 * Per-user mode resolution (ASYNC).
 *
 * The canonical answer for any request that has a userId. Resolution:
 *
 *   1. Explicit `GITHUB_AUTH_MODE` env var → used as-is (escape hatch).
 *   2. `CLOUD_MODE=true` (this IS api.openship.io) → "app".
 *   3. Self-hosted + the user is connected to Openship Cloud → "cloud-app".
 *      All App-scoped operations (install URL, list installations, mint
 *      install token, OAuth identity) proxy through api.openship.io.
 *   4. Self-hosted + NOT cloud-connected → "cli" (the gh CLI / PAT
 *      escape hatch — no App-scoped features available).
 */
export async function resolveGitHubAuthMode(ctx: RequestContext): Promise<GitHubAuthMode> {
  const explicit = env.GITHUB_AUTH_MODE;
  if (explicit !== "auto") return explicit as GitHubAuthMode;
  if (env.CLOUD_MODE) return "app";

  // Cloud connection is OWNED BY THE ORG OWNER, not the asking user. A
  // member never carries the org's cloud identity — so "cloud-app" must
  // be gated on the OWNER's validated session, keyed by ctx.organizationId.
  // This makes GitHub mode agree with the dashboard status card and deploy
  // preflight (all read the one org-scoped verdict), instead of flipping to
  // "cli" just because the member personally isn't cloud-connected. Falls
  // back to the user-scoped check only when there's no org context.
  try {
    const { isCloudConnectedForOrg, isCloudConnected } = await import(
      "../../lib/cloud/session"
    );
    const connected = ctx.organizationId
      ? await isCloudConnectedForOrg(ctx.organizationId)
      : await isCloudConnected(ctx.userId);
    if (connected) return "cloud-app";
  } catch {
    // cloud-client import / DB read failed → fall through to cli.
  }
  return "cli";
}

/**
 * Internal mode resolver — same logic as the exported
 * `resolveGitHubAuthMode(ctx)` but takes a bare userId. Used by:
 *   - other functions in this file that already operate on userId
 *     (`getUserStatus`, `getGitHubConnectionState`, etc.) and don't
 *     have a request ctx in scope.
 *   - `resolveAuthModeForOrgOwner` (background org-scoped lookups).
 * Not exported — foreground callers should go through the ctx-shaped
 * `resolveGitHubAuthMode`.
 */
async function resolveAuthModeForUserId(userId: string): Promise<GitHubAuthMode> {
  const explicit = env.GITHUB_AUTH_MODE;
  if (explicit !== "auto") return explicit as GitHubAuthMode;

  if (env.CLOUD_MODE) return "app";

  try {
    const { isCloudConnected } = await import("../../lib/cloud/session");
    if (await isCloudConnected(userId)) return "cloud-app";
  } catch {
    // If the cloud-client import / DB read fails, fall through to cli.
  }
  return "cli";
}

/**
 * Background/org-scoped variant — used by `getInstallationIdByOrg`
 * which has no per-request ctx (it's called from token preflight and
 * other system paths). Resolves the mode that the org OWNER would
 * see; if the org has no owner row (provisioning race) defaults to
 * "none" so the caller falls through to the local DB path.
 */
async function resolveAuthModeForOrgOwner(
  ownerUserId: string | undefined,
): Promise<GitHubAuthMode | "none"> {
  if (!ownerUserId) return "none";
  return resolveAuthModeForUserId(ownerUserId).catch(() => "none" as const);
}

/**
 * Get the GitHub App installation URL (sync, local-only).
 *
 * Used when this process IS the App owner — i.e. cloud-mode SaaS or an
 * explicit GITHUB_AUTH_MODE=app self-host with creds set. For the
 * canonical self-hosted path (cloud-app), use `resolveInstallUrl(userId)`
 * which proxies through openship.io and returns a state-bound URL.
 */
export function getInstallUrl(): string {
  // Single source of truth: env.GITHUB_APP_SLUG defaults to "openship-io"
  // via the zod schema in apps/api/src/config/env.ts. No fallback needed
  // here — the schema guarantees a value.
  return `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`;
}

/**
 * Per-user install URL resolution. In cloud-app mode this round-trips
 * through openship.io to get a state-bound URL; otherwise returns the
 * sync `getInstallUrl()` result. `state` is empty string when not
 * applicable (local-app mode).
 */
export async function resolveInstallUrl(
  ctx: RequestContext,
): Promise<{ url: string; state: string; cloudUnreachable?: boolean }> {
  const userId = ctx.userId;
  const organizationId = ctx.organizationId;
  const mode = await resolveGitHubAuthMode(ctx);
  if (mode === "cloud-app") {
    // Bind the install to the active org so the resulting installation
    // belongs to the team, not the clicking member. ctx.organizationId
    // is the canonical answer.
    const { cloudClient } = await import("../../lib/cloud/client");
    const res = await cloudClient({ organizationId }).github.installUrl();
    if (res) {
      // HIGH #6: bind the state nonce to THIS user/org locally so
      // the install-complete callback can verify the caller matches
      // the original requester. 10 min TTL covers the user's
      // GitHub-UI dwell time; longer windows just enlarge the
      // replay window.
      if (res.state) {
        await repos.githubInstallState.purgeExpired().catch(() => 0);
        await repos.githubInstallState.create({
          state: res.state,
          userId,
          organizationId,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        }).catch((err) => {
          console.warn(
            `[GitHub] failed to bind install state: ${(err as Error).message}`,
          );
        });
      }
      return res;
    }
    // SaaS-only mode: the GitHub App install URL MUST come from
    // openship.io — it carries the org-bound state nonce the
    // install-complete webhook needs to attribute the installation.
    // The SaaS is unreachable (or has no cloud-owner link), so there is
    // NO valid local fallback: a stateless github.com/apps/... URL would
    // open the install screen but silently orphan the install (HIGH #6).
    // Signal unreachable so the caller tells the user the truth instead
    // of handing them a dead link.
    console.warn(
      "[GitHub] install URL unavailable — Openship Cloud unreachable (cloud-app mode); refusing stateless local fallback",
    );
    return { url: "", state: "", cloudUnreachable: true };
  }
  // Local-app mode (GITHUB_AUTH_MODE=app with local App creds): the
  // self-hosted install URL is legitimately local and state-less.
  return { url: getInstallUrl(), state: "" };
}

/**
 * HIGH #6 — verify that an install-completion callback (state value)
 * matches the original requester. Returns the binding row on success
 * (one-shot: the row is consumed and deleted) and null on miss,
 * expiry, or user-id mismatch. The caller should refuse the operation
 * on null and surface a clear "install state mismatch" error.
 *
 * `expectedUserId` is the AUTHENTICATED user driving the callback.
 * If it doesn't match the userId stored at request time, the binding
 * is treated as missing AND the row is removed so the same state
 * value cannot be replayed against a different caller.
 */
export async function consumeInstallState(
  state: string,
  expectedUserId: string,
): Promise<{ userId: string; organizationId: string | null } | null> {
  if (!state) return null;
  const binding = await repos.githubInstallState.find(state).catch(() => null);
  if (!binding) return null;
  if (binding.userId !== expectedUserId) {
    // Different caller is trying to claim this state. Remove the row so
    // the original requester can re-issue cleanly.
    await repos.githubInstallState.remove(state).catch(() => {});
    return null;
  }
  // Atomic delete-and-return so a second concurrent attempt can't ride.
  const consumed = await repos.githubInstallState.consume(state).catch(() => null);
  if (!consumed) return null;
  return {
    userId: consumed.userId,
    organizationId: consumed.organizationId,
  };
}

/**
 * Resolve the GitHub OAuth start URL for this user.
 *
 * Cloud-app mode (self-hosted + Openship Cloud connected): proxies to the
 * SaaS's /oauth-handoff endpoint, which mints a single-use bridge URL.
 * The browser opens that URL and the SaaS handles the entire OAuth
 * round-trip — local never has GitHub OAuth credentials. After OAuth
 * completes, the SaaS has a Better Auth `account` row for this user.
 *
 * App mode (this IS the SaaS): linkSocialAccount is called directly via
 * the controller's connectRedirect handler — the OAuth flow runs in the
 * same process. resolveOauthHandoffUrl is not used.
 *
 * cli mode (self-hosted + NO cloud): there's no GitHub OAuth flow
 * available — the user can only use gh CLI. Returns null.
 */
export async function resolveOauthHandoffUrl(
  userId: string,
): Promise<{ url: string } | null> {
  // userId-only path — the OAuth handoff is initiated before any org
  // is in scope (it IS the connect flow). Use the internal resolver.
  const mode = await resolveAuthModeForUserId(userId);
  if (mode !== "cloud-app") return null;

  const { cloudClient } = await import("../../lib/cloud/client");
  return cloudClient({ userId }).github.oauthHandoff();
}

/**
 * Disconnect a user from a GitHub source.
 *
 * `source`:
 *   - "oauth" → remove the OAuth account row (Openship App / standalone OAuth)
 *   - "cli"   → set the cli-suppression flag so the host's `gh auth token`
 *               is ignored even when present. NEVER touches the host's gh
 *               config - we only refuse to use it.
 *   - "all"   → both of the above (default - preserves the old contract)
 *
 * GitHub App installations remain until GitHub sends uninstall/suspend events.
 */
export async function disconnectUser(
  userId: string,
  source: "oauth" | "cli" | "all" = "all",
): Promise<void> {
  if (source === "oauth" || source === "all") {
    await repos.account.unlinkProvider(userId, "github");
  }
  if (source === "cli" || source === "all") {
    const { setGithubCliDisabled } = await import("../settings/settings.service");
    await setGithubCliDisabled(userId, true);
    // Also drop the stored device-flow token. Without this, "Disconnect" only
    // flipped the per-user opt-in while the credential itself stayed on the
    // instance — so the UI said disconnected and clones kept working. Dynamic
    // import to keep the SaaS bundle free of the gh module (see its CLOUD_MODE
    // floor); a failure here must not abort the rest of the disconnect.
    try {
      const { setStoredDeviceToken } = await import("./github.local-auth");
      await setStoredDeviceToken(null);
    } catch (err) {
      console.warn(`[GitHub] clearing stored device token failed: ${(err as Error).message}`);
    }
  }
  await invalidateUserGitHubCache(userId);
  // Cascade MEDIUM — every org this user belongs to shares cache
  // entries with them (installation-id lookups, installation tokens).
  // If we only sweep the user-scoped namespace, an org teammate could
  // hit a cached installation token minted via this user's mint path
  // and continue to use the SaaS bridge after the user disconnected.
  // Sweep each membership so the disconnect actually closes the gate.
  try {
    const memberships = await repos.member.listByUser(userId).catch(() => []);
    for (const m of memberships) {
      if (m.organizationId) {
        await invalidateOrgGitHubCache(m.organizationId);
      }
    }
  } catch (err) {
    console.warn(
      `[GitHub] disconnect cache sweep failed for ${userId}: ${(err as Error).message}`,
    );
  }
}
