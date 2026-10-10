/**
 * Cloud transport — the authenticated wire from a self-hosted instance to the
 * API stored with the session. Official links use api.openship.io. A
 * self-hosted link uses that instance's origin. Auth is fully server-side:
 * the session lives (encrypted) in `user_settings.cloud_session_token`; this
 * layer reads it, presents it as a Bearer, and forwards the call.
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
import { reportCaughtError as observeCaughtError, diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { currentErrorContext } from "@repo/core/diagnostics/node";
import { repos } from "@repo/db";
import { SDK_SCOPE_HEADER } from "@repo/contracts";
import { createHash } from "node:crypto";
import { cloudRuntimeTarget, cloudRuntimeTargetId, env } from "../../config/env";
import { decrypt } from "../encryption";
import { parseAllowedCloudOrigin } from "./origin";
import type { StoredCloudSession } from "./types";
import {
  APP_VERSION,
  OPENSHIP_VERSION_HEADER,
  OPENSHIP_PLATFORM_HEADER,
} from "../app-version";

/** Max wait for the SaaS to send response headers before we give up (503).
 *  Bounds every proxied call; body streaming continues past this once headers land. */
const CLOUD_FETCH_HEADER_TIMEOUT_MS = 60_000;

export type CloudIdentity = Omit<StoredCloudSession, "token">;

export function sameCloudIdentity(left: CloudIdentity, right: CloudIdentity): boolean {
  return left.apiUrl === right.apiUrl && left.userId === right.userId &&
    left.organizationId === right.organizationId;
}

/** Only credentials verified at connect time are usable. An official link
 * must still name the configured Cloud API, so changing that API drops it.
 * A self-hosted link is marked `selfHosted` and is sent only to its own origin. */
export async function readCloudSession(userId: string): Promise<StoredCloudSession | null> {
  const settings = await repos.settings.findByUser(userId);
  if (!settings?.cloudSessionToken) return null;
  try {
    const session = JSON.parse(decrypt(settings.cloudSessionToken)) as StoredCloudSession;
    const apiUrl = parseAllowedCloudOrigin(session?.apiUrl);
    if (!session || !apiUrl || apiUrl !== session.apiUrl ||
      typeof session.token !== "string" || !session.token ||
      typeof session.userId !== "string" || !session.userId ||
      typeof session.organizationId !== "string" || !session.organizationId) return null;
    const official = apiUrl === cloudRuntimeTarget.api;
    if (!official && session.selfHosted !== true) return null;
    return session;
  } catch {
    return null;
  }
}

/** A reconnect can never hit credentials cached under a different session. */
export function cloudSessionCacheKey(userId: string, session: StoredCloudSession): string {
  return `${userId}:${createHash("sha256").update(JSON.stringify(session)).digest("hex")}`;
}

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
  expectedIdentity?: CloudIdentity,
): Promise<Response | null> {
  const session = await readCloudSession(userId);
  if (!session || (expectedIdentity && !sameCloudIdentity(session, expectedIdentity))) return null;
  if (!path.startsWith("/api/") || path.includes("#")) throw new Error("Invalid Cloud API path");

  const targetUrl = `${session.apiUrl}${path}`;
  const method = (init?.method ?? "GET").toUpperCase();
  console.log(`[cloud-client] → ${method} ${targetUrl}  (cloudRuntimeTargetId=${cloudRuntimeTargetId})`);
  // Deadline on getting response HEADERS, cleared the moment fetch() resolves —
  // so a dead/stalled SaaS can't hang the request forever, but streamed bodies
  // (SSE logs/build) are untouched (headers arrive fast, then the timer is off).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLOUD_FETCH_HEADER_TIMEOUT_MS);
  let res: Response;
  try {
    const headers = new Headers(init?.headers);
    const requestId = currentErrorContext().requestId;
    if (requestId) headers.set("X-Request-ID", requestId);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    headers.set(OPENSHIP_VERSION_HEADER, APP_VERSION);
    headers.set(OPENSHIP_PLATFORM_HEADER, env.DEPLOY_MODE);
    headers.set("X-Organization-Id", session.organizationId);
    headers.set(SDK_SCOPE_HEADER, "fixed");
    headers.set("Authorization", `Bearer ${session.token}`);
    res = await fetch(targetUrl, {
      ...init,
      headers,
      redirect: "error",
      signal: init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
    });
  } catch (err) {
    errorDiagnostics.warn("platform/engine/lib/cloud/transport", `[cloud-client] fetch failed ${targetUrl}: ${(err as Error).message}`, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
  console.log(`[cloud-client] ← ${method} ${targetUrl} ${res.status}`);

  // An account switch can finish while the upstream request is in flight.
  // Do not deliver the previous account's inventory, credentials or response.
  const current = await readCloudSession(userId);
  if (!current || !sameCloudIdentity(session, current)) {
    await res.body?.cancel().catch((diagnosticFailure) => {
      observeCaughtError(diagnosticFailure, "platform/engine/lib/cloud/transport");
    });
    return null;
  }

  if (res.status === 401) {
    errorDiagnostics.warn("platform/engine/lib/cloud/transport",
      `[cloud-client] 401 from SaaS for ${path} — leaving stored session intact; caller should surface the auth error.`,
    );
  }

  if (res.body && res.headers.get("content-type")?.includes("text/event-stream"))
    return pinnedCloudStream(res, userId, session);
  return res;
}

/** Live logs stop when the account is disconnected or replaced. Keep normal
 * stream backpressure; do not buffer an entire deployment in this gateway. */
function pinnedCloudStream(response: Response, userId: string, identity: CloudIdentity): Response {
  const reader = response.body!.getReader();
  let ended = false;
  let checking = false;
  let timer: ReturnType<typeof setInterval>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        if (ended || checking) return;
        checking = true;
        void readCloudSession(userId).then(current => {
          if (!ended && (!current || !sameCloudIdentity(identity, current))) {
            ended = true; clearInterval(timer);
            controller.close();
            void reader.cancel().catch((diagnosticFailure) => {
              observeCaughtError(diagnosticFailure, "platform/engine/lib/cloud/transport");
            });
          }
        }).catch((diagnosticFailure) => {
          observeCaughtError(diagnosticFailure, "platform/engine/lib/cloud/transport");
          if (ended) return;
          ended = true; clearInterval(timer);
          controller.close();
          void reader.cancel().catch((diagnosticFailure) => {
            observeCaughtError(diagnosticFailure, "platform/engine/lib/cloud/transport");
          });
        }).finally(() => { checking = false; });
      }, 5_000);
      timer.unref?.();
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (ended) return;
        if (next.done) { ended = true; clearInterval(timer); controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) {
        observeCaughtError(error, "platform/engine/lib/cloud/transport");
        if (!ended) { ended = true; clearInterval(timer); controller.error(error); }
      }
    },
    async cancel(reason) { ended = true; clearInterval(timer); await reader.cancel(reason); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
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
    .catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/lib/cloud/transport"); return undefined; });
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
  expectedIdentity?: CloudIdentity,
): Promise<Response | null> {
  const userId = await resolveOrgCloudUserId(organizationId);
  if (!userId) {
    // Silent null here is the classic "request never sent" — the SaaS
    // never logs it, and the caller (e.g. preflight) just sees null and
    // reports "unreachable". Make it visible so org/owner-link mismatches
    // are diagnosable instead of opaque.
    errorDiagnostics.warn("platform/engine/lib/cloud/transport",
      `[cloud-client] cloudFetchAsOrgOwner: no owner cloud-link for org ${organizationId} → ${path} not sent`,
    );
    return null;
  }
  return cloudFetch(userId, path, init, expectedIdentity);
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
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "platform/engine/lib/cloud/transport");
    return null;
  }
}
