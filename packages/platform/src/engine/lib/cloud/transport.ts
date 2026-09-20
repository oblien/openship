/**
 * Cloud transport — the authenticated wire from a self-hosted instance to
 * api.openship.io. Auth is fully server-side: the user's Openship Cloud
 * session lives (encrypted) in `user_settings.cloud_session_token`; this layer
 * reads it, presents it as a Bearer, and forwards the call.
 *
 * Two scopes, and everything resolves to the first:
 *   - cloudFetch(userId)          → call AS that user. This is the primitive:
 *                                   the connect/identity flow uses it directly,
 *                                   and every org-scoped call ends up here.
 *   - cloudFetchAsOrgOwner(orgId) → resolve the org's cloud-linked OWNER
 *                                   (resolveOrgCloudUserId), then cloudFetch as
 *                                   them. All org operations go through this.
 *
 * No client-side cookies or tokens are ever involved.
 */
import { repos } from "@repo/db";
import { cloudRuntimeTarget, cloudRuntimeTargetId, env } from "../../config/env";
import { decrypt } from "../encryption";
import {
  APP_VERSION,
  OPENSHIP_VERSION_HEADER,
  OPENSHIP_PLATFORM_HEADER,
} from "../app-version";

/** Max wait for the SaaS to send response headers before we give up (503).
 *  Bounds every proxied call; body streaming continues past this once headers land. */
const CLOUD_FETCH_HEADER_TIMEOUT_MS = 60_000;

/**
 * Make an authenticated request to the SaaS as `userId`: read the stored
 * session → decrypt → Bearer auth. Returns the Response, or null when the user
 * has no stored cloud session (or the fetch itself fails).
 *
 * A 401 is passed through UNTOUCHED — it does NOT mutate local state here. A
 * single transient/endpoint-specific 401 used to wipe the session + token
 * cache, which made every later cloud call return null and the dashboard show
 * "not connected" right after authorizing. Only the identity check
 * (validateCloudSession's /account 401) and explicit disconnect clear state.
 */
export async function cloudFetch(
  userId: string,
  path: string,
  init?: RequestInit,
): Promise<Response | null> {
  const settings = await repos.settings.findByUser(userId);
  if (!settings?.cloudSessionToken) return null;

  // A stored token that won't decrypt — a rotated/mismatched BETTER_AUTH_SECRET,
  // or a token written by a different instance (e.g. the CLI box vs `bun dev`) —
  // is unusable. Treat it as "no session" (→ graceful "not connected") instead
  // of throwing an unhandled 500 out of the status endpoint. Re-connecting
  // overwrites it with a token sealed under the current key.
  let sessionToken: string;
  try {
    sessionToken = decrypt(settings.cloudSessionToken);
  } catch {
    console.warn(
      `[cloud-client] cloudSessionToken for ${userId} failed to decrypt (BETTER_AUTH_SECRET mismatch?) — treating as disconnected`,
    );
    return null;
  }

  const targetUrl = `${cloudRuntimeTarget.api}${path}`;
  const method = (init?.method ?? "GET").toUpperCase();
  console.log(`[cloud-client] → ${method} ${targetUrl}  (cloudRuntimeTargetId=${cloudRuntimeTargetId})`);
  // Deadline on getting response HEADERS, cleared the moment fetch() resolves —
  // so a dead/stalled SaaS can't hang the request forever, but streamed bodies
  // (SSE logs/build) are untouched (headers arrive fast, then the timer is off).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLOUD_FETCH_HEADER_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(targetUrl, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
        // Identify THIS self-hosted instance's version + platform to the cloud
        // on every call, so the SaaS can gate on an outdated client (deprecate
        // old wire formats, nudge/force upgrades, etc.). Set AFTER the caller's
        // headers so they can't be spoofed/overridden by a request, and BEFORE
        // Authorization which is likewise authoritative.
        [OPENSHIP_VERSION_HEADER]: APP_VERSION,
        [OPENSHIP_PLATFORM_HEADER]: env.DEPLOY_MODE,
        Authorization: `Bearer ${sessionToken}`,
      },
      signal: controller.signal,
    });
  } catch (err) {
    console.warn(`[cloud-client] fetch failed ${targetUrl}: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
  console.log(`[cloud-client] ← ${method} ${targetUrl} ${res.status}`);

  if (res.status === 401) {
    console.warn(
      `[cloud-client] 401 from SaaS for ${path} — leaving stored session intact; caller should surface the auth error.`,
    );
  }

  return res;
}

/**
 * THE org→cloud-owner resolver: the userId of the org owner who has linked
 * Openship Cloud (`findOrgOwnerCloudLink` filters on a non-empty session
 * token), or null. Every org-scoped cloud path — the proxied fetch, the
 * cache-key resolution, the token mint, and the connection check — goes
 * through this single function so they all agree on the SAME owner identity.
 * Resolving it more than one way (e.g. a link-agnostic owner lookup for the
 * status check vs the cloud-linked owner for fetches) risks a split-brain
 * where the UI reports "connected" while deploys act as a different owner.
 *
 * NOTE: this resolves the owner whose settings row merely HAS a cloud token —
 * it is token-RETRIEVAL only, not a connection gate. "Is this org connected?"
 * is `isCloudConnectedForOrg` (session.ts), which live-validates the token.
 */
export async function resolveOrgCloudUserId(organizationId: string): Promise<string | null> {
  const linked = await repos.settings
    .findOrgOwnerCloudLink(organizationId)
    .catch(() => undefined);
  return linked?.userId ?? null;
}

/**
 * Org-bearing variant of cloudFetch. Resolves the org owner's cloud session
 * via resolveOrgCloudUserId, then makes the call as that user. Every org-scoped
 * cloud bridge function uses this — "any member of the org gets to act with the
 * owner's SaaS identity for org-scoped operations".
 *
 * Returns null when no member of the org has linked Openship Cloud.
 */
export async function cloudFetchAsOrgOwner(
  organizationId: string,
  path: string,
  init?: RequestInit,
): Promise<Response | null> {
  const userId = await resolveOrgCloudUserId(organizationId);
  if (!userId) {
    // Silent null here is the classic "request never sent" — the SaaS
    // never logs it, and the caller (e.g. preflight) just sees null and
    // reports "unreachable". Make it visible so org/owner-link mismatches
    // are diagnosable instead of opaque.
    console.warn(
      `[cloud-client] cloudFetchAsOrgOwner: no owner cloud-link for org ${organizationId} → ${path} not sent`,
    );
    return null;
  }
  return cloudFetch(userId, path, init);
}

/**
 * Defensive JSON parser for cloud responses. Cloud endpoints SHOULD return
 * application/json — but a dev server may serve a 200 HTML error page, or a
 * proxy may return a captive-portal page, etc. `.json()` on that body throws
 * "Unexpected token '<'" and crashes the calling handler.
 *
 * Use this for every cloud-client read: returns the parsed JSON when the body
 * is real JSON, otherwise null (caller treats as unreachable).
 */
export async function readCloudJson<T>(res: Response): Promise<T | null> {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return null;
  }
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
