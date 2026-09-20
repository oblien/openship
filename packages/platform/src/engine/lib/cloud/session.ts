/**
 * Cloud session lifecycle + connection truth.
 *
 *   store (cloud-auth-proxy.ts)  →  validate (live, here)  →  clear (here)
 *
 * "Connected?" is decided by the SaaS, never by local token existence: a
 * stored token is only a credential, and a stored-but-dead token must NOT read
 * as connected. So the connection check proxies the SaaS identity endpoint
 * (`/api/cloud/account`) LIVE and trusts its verdict.
 */
import { repos } from "@repo/db";
import { cacheStore } from "../cache-store/index";
import { requestMemo } from "../request-store";
import { cloudFetch, readCloudJson, resolveOrgCloudUserId } from "./transport";
import type { CloudAccount, TokenCache } from "./types";

// ─── Teardown ────────────────────────────────────────────────────────────────

/**
 * Wipe every local cache derived from the cloud session: the namespace-token
 * credential (so a reconnect can't reuse the old session's minted token) plus
 * the user's GitHub caches (cloud-app mode is backed by the cloud session, so
 * losing the session must force GitHub mode to re-resolve). Connection STATE
 * itself is never cached — validateCloudSession always proxies live.
 *
 * The GitHub invalidation is a DYNAMIC import to keep the static graph acyclic
 * (github.auth already lazily imports from this layer, so a static edge back
 * would form a cycle).
 */
export async function invalidateCloudCaches(userId: string): Promise<void> {
  const tokens = await cacheStore<TokenCache>("oblien-ns-tokens");
  await tokens.delete(userId);
  try {
    const { invalidateUserGitHubCache } = await import(
      "../../modules/github/github.auth"
    );
    await invalidateUserGitHubCache(userId);
  } catch {
    /* best-effort — github cache will self-heal on its own TTL */
  }
}

/**
 * Tear down the LOCAL cloud login entirely: null the stored bearer +
 * invalidate all derived caches. This is the local half of "disconnect" — it
 * does not call the SaaS. Fires when the SaaS rejects the session as invalid
 * (validateCloudSession's identity-endpoint 401) and from cloudClient().disconnect()
 * after the SaaS-side revoke.
 */
export async function clearCloudSession(userId: string): Promise<void> {
  await repos.settings.update(userId, { cloudSessionToken: null }).catch(() => {});
  await invalidateCloudCaches(userId);
}

// ─── Connection truth (live, single-flight) ──────────────────────────────────

/**
 * THE source of truth for "is this user connected to Openship Cloud":
 *
 *   - no stored token        → not connected (can't even ask)
 *   - SaaS 200               → connected (+ profile when present)
 *   - SaaS 401               → session genuinely dead → clear local token, disconnected
 *   - SaaS 5xx / unreachable → disconnected for this check; don't clear (transient)
 *
 * Single-flight, NOT a cache: concurrent identical checks within one burst
 * (a single github/home resolves auth-mode + user-status + install-url, and
 * the dashboard may fire more than one at once) share ONE in-flight `/account`
 * call. The entry is deleted the moment it settles, so the next request still
 * proxies live — collapsing a simultaneous storm into one round-trip without
 * ever serving a stale verdict across requests.
 */
const inflightValidate = new Map<
  string,
  Promise<{ connected: boolean; user?: CloudAccount }>
>();

function validateCloudSession(
  userId: string,
): Promise<{ connected: boolean; user?: CloudAccount }> {
  // Per-request memo FIRST: a single inbound request validates the session
  // once (a /github/status used to fan out into ~6 /cloud/account calls). The
  // next request gets a fresh store → still proxies live, never stale across
  // requests. The inflight single-flight below still collapses concurrent
  // calls when there's no request store (cron / boot / background jobs).
  return requestMemo(`cloud-session:${userId}`, () => validateCloudSessionLive(userId));
}

async function validateCloudSessionLive(
  userId: string,
): Promise<{ connected: boolean; user?: CloudAccount }> {
  const existing = inflightValidate.get(userId);
  if (existing) return existing;

  const work = (async (): Promise<{ connected: boolean; user?: CloudAccount }> => {
    const settings = await repos.settings.findByUser(userId);
    if (!settings?.cloudSessionToken) return { connected: false };

    const res = await cloudFetch(userId, "/api/cloud/account", { method: "GET" });
    if (!res) return { connected: false }; // fetch threw → transient, don't clear

    if (res.status === 401) {
      // Identity-endpoint 401 = the session token is invalid. The ONE
      // place we treat a 401 as authoritative "disconnected".
      await clearCloudSession(userId);
      return { connected: false };
    }
    if (!res.ok) return { connected: false }; // transient (5xx etc.) — don't clear

    const user = (await readCloudJson<{ user?: CloudAccount }>(res))?.user;
    return { connected: true, ...(user ? { user } : {}) };
  })();

  inflightValidate.set(userId, work);
  try {
    return await work;
  } finally {
    inflightValidate.delete(userId);
  }
}

/**
 * Boolean connection check. Source of truth is the SaaS (see
 * validateCloudSession) — NOT local token existence. Gates GitHub auth-mode
 * resolution, so a dead cloud session correctly drops GitHub out of
 * `cloud-app` mode instead of leaving it stuck calling a SaaS that 401s.
 */
export async function isCloudConnected(userId: string): Promise<boolean> {
  return (await validateCloudSession(userId)).connected;
}

/**
 * THE source of truth for "is this ORG connected to Openship Cloud".
 *
 * Connection is owned by the org OWNER — only the owner can link cloud, and
 * their session is the org's single cloud identity that every org-scoped
 * operation (deploy, edge proxy, analytics, GitHub App tokens) flows through.
 * So we resolve the owner via the SAME resolver the fetch/token paths use and
 * validate THEIR session — UI, GitHub mode, and deploys read ONE org-scoped
 * verdict and can never disagree (no split-brain).
 */
async function validateCloudSessionForOrg(
  organizationId: string,
): Promise<{ connected: boolean; user?: CloudAccount }> {
  const userId = await resolveOrgCloudUserId(organizationId);
  if (!userId) return { connected: false };
  return validateCloudSession(userId);
}

export async function isCloudConnectedForOrg(
  organizationId: string,
): Promise<boolean> {
  return (await validateCloudSessionForOrg(organizationId)).connected;
}

export async function getCloudConnectionStatusForOrg(
  organizationId: string,
): Promise<{ connected: boolean; user?: CloudAccount }> {
  return validateCloudSessionForOrg(organizationId);
}
