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

import { assertCloudTenantScope } from "../../lib/cloud/scope";
import { mayUseInstanceGitIdentity } from "./github-instance-access";
import crypto from "crypto";
import { repos, db, schema, eq, and } from "@repo/db";
import { APIError } from "better-auth/api";
import { safeErrorMessage } from "@repo/core";
import { env, localGitHubAppConfiguration } from "../../config/env";
import { auth } from "../../lib/auth";
import { cacheStore } from "../../lib/cache-store/index";
// gh-CLI (github.local-auth) is imported DYNAMICALLY at its two self-hosted
// call sites (getUserStatus "cli" branch, getGitHubConnectionState gh probe)
// so the gh module never loads in CLOUD_MODE (the SaaS). See those sites.
import { ghFetch, ghFetchPublic, ghFetchSoft } from "./github.http";
import { mapAccounts } from "./sources/mappers";
import type { ExecutionContext as RequestContext } from "@repo/platform";
import type { GitHubTokenSource } from "./github.token";
import { resolveOrgOwner } from "../../lib/org-actor";
import type { GitHubConnectionState, GitHubInstallation, MappedAccount } from "@repo/contracts";
import { generateGitHubAppJwt, githubAppFetch } from "./github.app-client";
import {
  createSourceInstallUrl,
  hasActiveGitHubSource,
  resolveGitHubApiBaseUrl,
  resolveGitHubSourceCredentialsForInstallation,
} from "./github-source.service";

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
const PRIVATE_KEY: string | null =
  env.GITHUB_PRIVATE_KEY ??
  (env.GITHUB_PRIVATE_KEY_BASE64
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

  return generateGitHubAppJwt({ appId, privateKeyPem: PRIVATE_KEY });
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
  if (!env.GITHUB_APP_ID || !PRIVATE_KEY) {
    // Keep the historic, specific configuration messages from generateAppJwt.
    generateAppJwt();
  }
  return githubAppFetch<T>(
    { appId: env.GITHUB_APP_ID!, privateKeyPem: PRIVATE_KEY! },
    url,
    options,
  );
}

// ─── Installation ID lookup ──────────────────────────────────────────────────

/**
 * Resolve the GitHub App installation ID for a given user + owner.
 * Checks cache first, then the database.
 *
 * Takes a RequestContext so cloud-app mode can look up the canonical
 * org-scoped install state via `ctx.organizationId` — no more
 * memberships[0] guessing. When the resolved mode isn't cloud-app, the
 * lookup uses the active workspace row. A user's installation in another
 * workspace is never a fallback credential for this request.
 */
export async function getInstallationId(
  ctx: RequestContext,
  owner: string,
): Promise<number | null> {
  if (!owner) return null;
  const organizationId = ctx.organizationId;
  const cacheKey = `inst:org:${organizationId}:${owner.toLowerCase()}`;
  const store = await cacheStore<string>(GH_TOKEN_NS, { maxSize: 5_000 });
  const cached = await store.get(cacheKey);
  if (cached) return Number(cached);

  // Source selection is per owner. Adding a custom App for one account must
  // not steal unrelated owners from the existing Cloud, CLI or env-backed
  // integration configured for this workspace.
  const local = await repos.gitInstallation.findByOrgAndOwner(organizationId, owner);
  if (local?.sourceId) {
    await store.set(cacheKey, String(local.installationId), GITHUB_TOKEN_CACHE_TTL_SECONDS);
    return local.installationId;
  }

  // For an owner not covered by a custom source, preserve the pre-source auth
  // mode. In cloud-app mode api.openship.io remains authoritative; a legacy
  // local snapshot must never shadow it.
  const mode = await resolveGitHubFallbackAuthMode(ctx).catch(() => "none" as const);
  if (mode === "cloud-app") {
    assertCloudTenantScope(ctx);
    // ctx.organizationId is the canonical answer — permission.assert
    // has already rebound it to the resource-scoped org when this is a
    // resource-bound route, so we never need to guess memberships[0].
    const { cloudClient } = await import("../../lib/cloud/client");
    const list = await cloudClient({ organizationId })
      .github.installations()
      .catch(() => null);
    if (!list) return null;
    const match = list.find((entry) => entry.login.toLowerCase() === owner.toLowerCase());
    if (!match) return null;
    await store.set(cacheKey, String(match.id), GITHUB_TOKEN_CACHE_TTL_SECONDS);
    return match.id;
  }

  // A source-less row can only be minted by the legacy env-backed App. OAuth,
  // token and CLI modes may have historical rows, but none owns an App key, so
  // reporting those rows as mintable makes preflight pass and deployment fail.
  if (mode !== "app" || !local) return null;

  await store.set(cacheKey, String(local.installationId), GITHUB_TOKEN_CACHE_TTL_SECONDS);
  return local.installationId;
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

  // A workspace-owned source is fully local and intentionally wins over the
  // optional Openship Cloud bridge. It was explicitly configured for this org.
  const local = await repos.gitInstallation.findByOrgAndOwner(organizationId, owner);
  if (local?.sourceId) {
    await store.set(cacheKey, String(local.installationId), GITHUB_TOKEN_CACHE_TTL_SECONDS);
    return local.installationId;
  }

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
    const list = await cloudClient({ organizationId })
      .github.installations()
      .catch(() => null);
    if (!list) return null;
    const match = list.find((entry) => entry.login.toLowerCase() === owner.toLowerCase());
    if (!match) return null;
    await store.set(cacheKey, String(match.id), GITHUB_TOKEN_CACHE_TTL_SECONDS);
    return match.id;
  }

  // A legacy row is usable only when this process actually owns the App key.
  // In CLI/OAuth/token mode an old row is metadata, not a credential. Keep the
  // CLOUD_MODE/no-owner background path working via the synchronous resolver.
  if (mode !== "app" && getGitHubAuthMode() !== "app") return null;

  // Self-hosted env-App / SaaS mode. The webhook fires to us, so local DB is
  // the source of truth.
  const row = local ?? (await repos.gitInstallation.findByOrgAndOwner(organizationId, owner));
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
  const organizationId = ctx.organizationId;

  // Resolve a workspace-owned source before consulting the legacy mode. Custom
  // Apps are per owner; their presence elsewhere in the workspace must not turn
  // a source-less historical row into an env-App credential.
  let installation = installationId
    ? await repos.gitInstallation.findByOrgOwnerAndInstallationId(
        organizationId,
        owner,
        installationId,
      )
    : undefined;
  installation ??= await repos.gitInstallation.findByOrgAndOwner(organizationId, owner);
  const custom = installation?.sourceId
    ? await resolveGitHubSourceCredentialsForInstallation(
        organizationId,
        owner,
        installation.installationId,
      )
    : null;
  // A source-bound installation must never fall through to the process-wide
  // App key if its source disappears between the row and credential lookups.
  if (installation?.sourceId && custom?.source.id !== installation.sourceId) return null;

  const mode = custom ? "app" : await resolveGitHubFallbackAuthMode(ctx);

  // Narrowed and broad tokens MUST NOT share a cache entry: a broad token served
  // from the narrow key would silently over-grant, and a narrow token served from
  // the broad key would break unrelated callers. Sorted + lowercased so the same
  // repo set always produces the same key.
  const repoScope = opts.repositories?.length
    ? `:repos:${[...opts.repositories]
        .map((r) => r.toLowerCase())
        .sort()
        .join(",")}`
    : "";

  if (mode === "cloud-app") {
    assertCloudTenantScope(ctx);
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
        (minted as { expiresAt?: string }).expiresAt ??
        new Date(Date.now() + 55 * 60 * 1000).toISOString(),
    };
    await store.set(cacheKey, encodeTokenEnvelope(envelope), GITHUB_TOKEN_CACHE_TTL_SECONDS);
    return envelope.token;
  }

  // CLI, PAT and OAuth modes do not possess a legacy App private key. Their
  // token-chain steps remain available after this returns null.
  if (mode !== "app") return null;

  // Local-mint path (cloud-mode SaaS or a self-hosted operator-owned App).
  // Always resolve the canonical workspace row, even when a project snapshot
  // supplied an installation id. That snapshot is useful for webhook tenant
  // matching but is not authorization: it may be stale after reinstall, and a
  // caller-controlled/legacy value must never let this App mint for another
  // workspace's installation.
  if (!installation) return null;
  installationId = installation.installationId;

  // The installation token from GitHub is keyed purely on the
  // installationId (an org-wide GitHub resource), so every member of
  // the same org should share one cache entry. Key by org so teammates
  // hit the same mint result.
  const sourceKey = custom?.source.id ?? "legacy";
  const cacheKey = `instToken:local:org:${organizationId}:${sourceKey}:${owner}:${installationId}${repoScope}`;
  const store = await cacheStore<string>(GH_TOKEN_NS, { maxSize: 5_000 });
  const cachedRaw = await store.get(cacheKey);
  if (cachedRaw) {
    const cached = decodeTokenEnvelope(cachedRaw);
    if (cached && isCachedTokenStillFresh(cached)) return cached.token;
  }

  try {
    const request = {
      method: "POST",
      ...(opts.repositories?.length ? { body: { repositories: opts.repositories } } : {}),
    };
    const data = custom
      ? await githubAppFetch<{ token: string; expires_at: string }>(
          custom.credentials,
          `/app/installations/${installationId}/access_tokens`,
          request,
        )
      : await appFetch<{ token: string; expires_at: string }>(
          `https://api.github.com/app/installations/${installationId}/access_tokens`,
          request,
        );
    const envelope: CachedInstallationToken = {
      token: data.token,
      // GitHub's `expires_at` is the SOURCE OF TRUTH for token lifetime.
      // Fall back to a 55-minute window only if the field is missing
      // (shouldn't happen on api.github.com, but defends against
      // GitHub Enterprise variants and test fixtures).
      expiresAt: data.expires_at ?? new Date(Date.now() + 55 * 60 * 1000).toISOString(),
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
      await dropStaleInstallationRows(owner, installationId, installation.sourceId).catch(() => {
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
async function dropStaleInstallationRows(
  owner: string,
  installationId: number,
  sourceId?: string | null,
): Promise<void> {
  const rows = await repos.gitInstallation
    .findByInstallationIdForProvider(installationId, sourceId)
    .catch(() => []);
  const matching = rows.filter((row) => row.owner.toLowerCase() === owner.toLowerCase());
  if (matching.length === 0) return;
  // A GitHub installation id is global for this App. A 404 means every local
  // workspace binding to it is stale, not merely the current member's row.
  await repos.gitInstallation.removeByInstallationIdForProvider(installationId, sourceId);
  await Promise.all(
    [...new Set(matching.map((row) => row.userId))].map((id) => invalidateUserGitHubCache(id)),
  );
  await Promise.all(
    [...new Set(matching.map((row) => row.organizationId))].map((id) =>
      invalidateOrgGitHubCache(id),
    ),
  );
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
  /** Repo name. Threaded to `tokenFor` so the mint is gated PER-REPO — a grant
   *  on repo A must not authorize an operation on repo B under the same owner.
   *  Omitting it on a repo-specific call reopens the owner-wide half of
   *  GHSA-hp2g-hw7g-f3vm, so pass it whenever the URL names a repo. */
  repo?: string;
  /**
   * Narrow the mint gate's tier to "read". Defaults to the HTTP method: GET →
   * "read", anything else → "write".
   *
   * The method is only a PROXY for the tier — the tier is a property of what the
   * operation MEANS, and two mutating calls can sit on different sides of it.
   * Registering a read-only deploy key or posting a check-run status is part of
   * "deploy this repo", which a read grant authorizes; deleting the repo or
   * managing its webhooks is repo ADMINISTRATION, which it must not.
   *
   * Deliberately typed `"read"` and not `GitHubAccessOp`: the only sound use is
   * narrowing, so the type — not a comment someone has to obey — is what stops this
   * from becoming a way to declare a management call harmless. Widening is what
   * GHSA-hp2g-hw7g-f3vm did by accident.
   */
  authorizeAs?: "read";
  /**
   * Pin resolution to specific credential kinds, for an endpoint only ONE
   * credential can satisfy. Orthogonal to `authorizeAs`: that is AUTHORITY
   * ("may this caller?"), this is CAPABILITY ("can this credential at all?").
   *
   * Check-runs pass `["app-installation"]` because GitHub's Checks API rejects
   * user tokens — and on self-hosted the chain hands back the operator's gh-CLI
   * token FIRST, which silently 403s every check even when a working App
   * installation sits one step later. Webhook writes deliberately DON'T pin: a
   * PAT can administer hooks, and pinning would break self-hosts with no App.
   */
  credential?: GitHubTokenSource[];
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
 *     via `tokenFor(ctx, "local", ...)`, whose ORDER IS PLATFORM-SPECIFIC —
 *     saas: PAT → App → OAuth, but SELFHOSTED: gh-CLI → App → PAT → OAuth
 *     (CHAINS in github.token.ts). So skipping the gh-first shortcut above does
 *     NOT mean "not gh": on a self-hosted box gh-CLI is the chain's FIRST step,
 *     and tokenFor returns the first token it resolves without ever retrying.
 *     An endpoint only ONE credential can satisfy must therefore say so:
 *     check-runs pass `credential: ["app-installation"]`, because GitHub's
 *     Checks API rejects user tokens. Webhooks deliberately do not — a PAT can
 *     administer hooks, and pinning them would break self-hosts with no App.
 *
 * Appends query params for GET requests, sends JSON body for others.
 */
export async function githubFetch<T = unknown>(opts: GitHubFetchOptions): Promise<T> {
  const method = opts.method ?? "GET";
  const customApiBase = opts.owner
    ? await resolveGitHubApiBaseUrl(opts.ctx.organizationId, opts.owner, opts.installationId).catch(
        () => null,
      )
    : null;

  // gh-first for local reads unless this owner is explicitly backed by a
  // workspace custom App. A github.com CLI credential cannot authenticate to a
  // GitHub Enterprise source, and an explicitly configured App is narrower.
  if (method === "GET" && !customApiBase) {
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
    repo: opts.repo,
    installationId: opts.installationId,
    // A GET is a read; anything else mutates unless the caller declared its tier
    // explicitly. Threading the op means a mutating GitHub call can only mint a
    // token when the caller holds a WRITE grant on THIS repo — closing
    // GHSA-hp2g-hw7g-f3vm at the single funnel every mint passes through,
    // independent of whatever the route-level role check allowed.
    op: opts.authorizeAs ?? (method === "GET" ? "read" : "write"),
    only: customApiBase ? ["app-installation"] : opts.credential,
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
  const url =
    result?.source === "app-installation" &&
    customApiBase &&
    opts.url.startsWith("https://api.github.com")
      ? `${customApiBase}${opts.url.slice("https://api.github.com".length)}`
      : opts.url;
  return ghFetch<T>(token, {
    url,
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
export async function getUserStatus(userId: string, ctx?: RequestContext) {
  // userId-only path — getUserStatus is called from background sync
  // (no Hono ctx) and from per-user controllers; both already operate
  // off the bare userId. Use the internal mode resolver.
  const mode = ctx ? await resolveGitHubAuthMode(ctx) : await resolveAuthModeForUserId(userId);

  // ── Cloud-app: status comes from openship.io ────────────────────────────
  if (mode === "cloud-app") {
    if (ctx) assertCloudTenantScope(ctx);
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
      token = !ctx || await mayUseInstanceGitIdentity(ctx) ? env.GITHUB_TOKEN ?? null : null;
      break;
    case "cli": {
      token = await getUserToken(userId);
      if (token) {
        tokenSource = "oauth";
        break;
      }
      // gh CLI fallback - only if the user hasn't explicitly disconnected it.
      // Otherwise a user who clicked "Disconnect" from cli mode would silently
      // stay connected because gh is still authed on the host.
      const { isGithubCliDisabled } = await import("../settings/settings.service");
      const cliDisabled = await isGithubCliDisabled(userId);
      if (cliDisabled) break;
      if (ctx && !(await mayUseInstanceGitIdentity(ctx))) break;
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

  // Soft on purpose, and it always was: a revoked token, a 403 and github.com being down
  // are one answer to the question this function asks. Via the shared primitive rather than
  // a bare `fetch` so it is bounded — an unbounded call here hung the connection status
  // panel on a stalled github.com, with nothing to show why.
  const user = await ghFetchSoft<{ login: string; id: number; avatar_url: string }>(token, {
    url: "https://api.github.com/user",
  });
  if (!user) {
    return { connected: false as const, tokenSource: null };
  }
  return { connected: true as const, tokenSource, oauthConnected: true as const, ...user };
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
        .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, "github")));
      githubRowCount = rows.length;
    } catch (err) {
      console.log(`[cloud-saas:githubUserStatus] account lookup failed: ${safeErrorMessage(err)}`);
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
    const status = await getUserStatus(userId, ctx);
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
  if (onSelfHosted && await mayUseInstanceGitIdentity(ctx)) {
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
  const customConfigured =
    !env.CLOUD_MODE && (await hasActiveGitHubSource(organizationId).catch(() => false));
  const customInstallations = customConfigured
    ? await getStoredInstallationsForOrganization(organizationId, true)
    : [];
  // A custom source augments the existing integration. It is authoritative for
  // owners it covers, but it must not hide installations that still come from
  // Openship Cloud or the user's OAuth connection.
  const mode = customConfigured
    ? await resolveGitHubFallbackAuthMode(ctx)
    : await resolveGitHubAuthMode(ctx);

  if (mode === "cloud-app") {
    assertCloudTenantScope(ctx);
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
    const cloudInstallations = (list ?? []).map((entry) => ({
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
    return mergeInstallations(customInstallations, cloudInstallations);
  }

  // App installations are claimed into a specific workspace by the one-time
  // setup callback. Never re-sync every installation visible to this user's
  // OAuth token into whichever workspace happens to be active: that silently
  // moves credentials between teams. The callback verifies GitHub-side access
  // before writing these rows.
  if (mode === "app") {
    return getStoredInstallationsForOrganization(organizationId);
  }

  const token = await getUserToken(userId);
  if (!token) return customInstallations;

  try {
    const userStatus = status ?? (await getUserStatus(userId));
    if (!userStatus.connected) return customInstallations;

    const data = await githubFetch<{ installations: GitHubInstallation[] }>({
      ctx,
      url: "https://api.github.com/user/installations",
    });

    const installations = data.installations ?? [];

    try {
      // Foreground request — ctx.organizationId is the authoritative
      // org for this user's installs sync.
      await repos.gitInstallation.replaceForUserInOrganization(
        userId,
        organizationId,
        installations.map((installation) => ({
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

    return mergeInstallations(customInstallations, installations);
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
    return getStoredInstallationsForOrganization(organizationId);
  }
}

async function getStoredInstallationsForOrganization(
  organizationId: string,
  customOnly = false,
): Promise<GitHubInstallation[]> {
  const [installations, sources] = await Promise.all([
    repos.gitInstallation.listByOrganization(organizationId),
    repos.gitSource.listActiveByOrganization(organizationId).catch(() => []),
  ]);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  return installations
    .filter((installation) => !customOnly || installation.sourceId !== null)
    .map((installation) => ({
      id: installation.installationId,
      account: {
        login: installation.owner,
        id: storedAccountId(installation.providerOwnerId),
        avatar_url: storedAccountAvatarUrl(
          installation.owner,
          installation.providerOwnerId,
          installation.sourceId ? sourceById.get(installation.sourceId)?.webBaseUrl : undefined,
        ),
        type: installation.ownerType === "Organization" ? "Organization" : "User",
      },
      app_id:
        (installation.sourceId ? sourceById.get(installation.sourceId)?.appId : undefined) ??
        Number(env.GITHUB_APP_ID ?? 0),
      target_type: installation.ownerType,
      permissions: {},
      events: [],
    }));
}

/** Merge installation catalogs by owner, preserving the first list's source
 * preference. The rest of the GitHub UI selects accounts by login, so returning
 * duplicate rows for the same owner would create duplicate controls without a
 * way for the user to distinguish them. */
function mergeInstallations(...lists: GitHubInstallation[][]): GitHubInstallation[] {
  const merged = new Map<string, GitHubInstallation>();
  for (const list of lists) {
    for (const installation of list) {
      const key = installation.account.login.toLowerCase();
      if (!merged.has(key)) merged.set(key, installation);
    }
  }
  return [...merged.values()];
}

function storedAccountId(providerOwnerId?: string | null): number {
  const id = Number(providerOwnerId);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function storedAccountAvatarUrl(
  owner: string,
  providerOwnerId?: string | null,
  webBaseUrl = "https://github.com",
): string {
  const id = storedAccountId(providerOwnerId);
  if (webBaseUrl === "https://github.com" && id > 0) {
    return `https://avatars.githubusercontent.com/u/${id}?v=4`;
  }
  return `${webBaseUrl.replace(/\/+$/, "")}/${encodeURIComponent(owner)}.png`;
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
  // SaaS owns one canonical GitHub integration. No environment override may
  // route a multi-tenant cloud process into OAuth-only, CLI, or PAT behavior.
  if (env.CLOUD_MODE) return "app";

  const explicit = env.GITHUB_AUTH_MODE;
  if (explicit !== "auto") return explicit as GitHubAuthMode;

  if (localGitHubAppConfiguration.configured) return "app";
  return "cli";
}

/**
 * Per-user mode resolution (ASYNC).
 *
 * The canonical answer for any request that has a userId. Resolution:
 *
 *   1. `CLOUD_MODE=true` (this IS api.openship.io) → "app", unconditionally.
 *   2. A workspace-owned custom App → "app" for the composite source UI.
 *   3. Explicit `GITHUB_AUTH_MODE` env var → used as-is on self-hosted only.
 *   4. Self-hosted + the user is connected to Openship Cloud → "cloud-app".
 *      All App-scoped operations (install URL, list installations, mint
 *      install token, OAuth identity) proxy through api.openship.io.
 *   5. Self-hosted + NOT cloud-connected → "cli" (the gh CLI / PAT
 *      escape hatch — no App-scoped features available).
 *
 * Credential resolution is owner-aware and calls
 * `resolveGitHubFallbackAuthMode` when no custom source covers the requested
 * owner. The workspace-level answer here must never make one custom App hijack
 * unrelated legacy/Cloud owners.
 */
export async function resolveGitHubAuthMode(ctx: RequestContext): Promise<GitHubAuthMode> {
  if (env.CLOUD_MODE) return "app";

  // A source created in the dashboard is an explicit, workspace-scoped App
  // configuration. It takes precedence over the legacy process-wide mode: an
  // operator must not be able to save a valid App and then have every runtime
  // path silently keep using `gh` because GITHUB_AUTH_MODE was left at `cli`.
  if (await hasActiveGitHubSource(ctx.organizationId).catch(() => false)) return "app";

  return resolveGitHubFallbackAuthMode(ctx);
}

/** Resolve the pre-custom-source mode for an owner not backed by a custom App. */
async function resolveGitHubFallbackAuthMode(ctx: RequestContext): Promise<GitHubAuthMode> {
  if (env.CLOUD_MODE) return "app";

  const explicit = env.GITHUB_AUTH_MODE;
  if (explicit !== "auto") return explicit as GitHubAuthMode;
  if (localGitHubAppConfiguration.configured) return "app";

  // Cloud connection is OWNED BY THE ORG OWNER, not the asking user. A
  // member never carries the org's cloud identity — so "cloud-app" must
  // be gated on the OWNER's validated session, keyed by ctx.organizationId.
  // This makes GitHub mode agree with the dashboard status card and deploy
  // preflight (all read the one org-scoped verdict), instead of flipping to
  // "cli" just because the member personally isn't cloud-connected. Falls
  // back to the user-scoped check only when there's no org context.
  try {
    const { isCloudConnectedForOrg, isCloudConnected } = await import("../../lib/cloud/session");
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
  if (env.CLOUD_MODE) return "app";

  const explicit = env.GITHUB_AUTH_MODE;
  if (explicit !== "auto") return explicit as GitHubAuthMode;

  if (localGitHubAppConfiguration.configured) return "app";

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
 * through openship.io to get a state-bound URL. A self-hosted local App mints
 * the same one-shot user/workspace binding locally; stateless install URLs are
 * never returned because the setup redirect's installation_id is untrusted.
 */
export async function resolveInstallUrl(
  ctx: RequestContext,
  sourceId?: string,
): Promise<{ url: string; state: string; cloudUnreachable?: boolean }> {
  const userId = ctx.userId;
  const organizationId = ctx.organizationId;
  if (sourceId) {
    if (ctx.role !== "owner") return { url: "", state: "" };
    return createSourceInstallUrl(ctx, sourceId);
  }
  const preferredSource =
    (await repos.gitSource.findDefault(organizationId).catch(() => undefined)) ??
    (await repos.gitSource.listActiveByOrganization(organizationId).catch(() => []))[0];
  if (preferredSource) {
    return ctx.role === "owner"
      ? createSourceInstallUrl(ctx, preferredSource.id)
      : { url: "", state: "" };
  }

  const mode = await resolveGitHubAuthMode(ctx);
  if (mode === "cloud-app") {
    assertCloudTenantScope(ctx);
    // Bind the install to the active org so the resulting installation
    // belongs to the team, not the clicking member. ctx.organizationId
    // is the canonical answer.
    const { cloudClient } = await import("../../lib/cloud/client");
    const res = await cloudClient({ organizationId }).github.installUrl();
    if (res) {
      // The Openship App's Setup URL returns to Cloud, so Cloud's durable DB
      // binding is authoritative. Persisting the same nonce locally creates a
      // dead second copy that no callback can consume.
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
  if (mode === "app" && !env.CLOUD_MODE) {
    const state = crypto.randomBytes(24).toString("base64url");
    await repos.githubInstallState.purgeExpired().catch(() => 0);
    await repos.githubInstallState.create({
      state,
      userId,
      organizationId,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    return {
      url: `${getInstallUrl()}?state=${encodeURIComponent(state)}`,
      state,
    };
  }
  if (mode === "app" && env.CLOUD_MODE) {
    // This process owns the SaaS App. Reuse the same org-bound issuer used by
    // self-hosted cloud proxies so direct SaaS dashboard/project/preflight
    // affordances never leak a raw, unattributable installation URL.
    const { buildOrgScopedInstallUrl } = await import("../cloud/cloud-github.service");
    const install = await buildOrgScopedInstallUrl(userId, organizationId);
    return { url: install.url, state: install.state };
  }
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
  expectedOrganizationId?: string,
): Promise<{ userId: string; organizationId: string | null } | null> {
  if (!state) return null;
  const binding = await repos.githubInstallState.find(state).catch(() => null);
  if (!binding) return null;
  if (
    binding.userId !== expectedUserId ||
    (expectedOrganizationId !== undefined && binding.organizationId !== expectedOrganizationId)
  ) {
    // Do not consume on a caller/workspace mismatch. The nonce is unguessable,
    // and preserving it lets the legitimate user return to the originating
    // workspace instead of allowing a cross-workspace tab switch to destroy it.
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
export async function resolveOauthHandoffUrl(userId: string): Promise<{ url: string } | null> {
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
      const { setStoredDeviceToken, cancelInstanceDeviceFlows } = await import("./github.local-auth");
      await cancelInstanceDeviceFlows();
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
    console.warn(`[GitHub] disconnect cache sweep failed for ${userId}: ${(err as Error).message}`);
  }
}
