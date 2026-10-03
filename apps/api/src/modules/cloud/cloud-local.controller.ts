/**
 * Cloud local controller - runs only when !CLOUD_MODE.
 *
 * Dynamic imports for security isolation: cloud-client and cloud-auth-proxy
 * are never loaded on the SaaS. This prevents self-hosted code paths
 * (which handle user credentials, SSH config, etc.) from being accessible
 * in the SaaS process.
 *
 *   POST /api/cloud/disconnect      - clear stored session
 *   GET  /api/cloud/status          - check connection state
 */

import { safeErrorMessage } from "@repo/core";
import type { Context } from "hono";
import { repos } from "@repo/db";
import { getRequestContext } from "../../lib/request-context";
import { audit, auditContextFrom } from "../../lib/audit";
import { cloudClient } from "@repo/platform/engine/lib/cloud/client";
import { getCloudConnectionStatusForOrg } from "@repo/platform/engine/lib/cloud/session";

// ─── Cloud account management ────────────────────────────────────────────────

export async function disconnect(c: Context) {
  const ctx = getRequestContext(c);
  // Connection is org-owned: disconnect THE ORG's cloud session (the
  // owner's). The route is owner-gated (requireRole("owner")), so the
  // caller is the owner — org scope resolves and clears the owner link.
  await cloudClient({ organizationId: ctx.organizationId }).disconnect();
  // Disconnecting cloud removes the org's GitHub App identity entirely,
  // so every member-level GitHub grant is now moot — prune them.
  await repos.resourceGrant
    .deleteAllGitHubGrants(ctx.organizationId)
    .catch(() => 0);
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "cloud.disconnect",
    resourceType: "cloud",
    resourceId: "*",
  });
  return c.json({ connected: false });
}

export async function status(c: Context) {
  const ctx = getRequestContext(c);
  // Org-scoped on purpose: cloud connection belongs to the org OWNER, so
  // ANY member sees the SAME verdict (the owner's validated session), and
  // it matches exactly what deploy preflight uses. Never the asking
  // user's own token — that was the split-brain.
  return c.json(await getCloudConnectionStatusForOrg(ctx.organizationId));
}

/**
 * POST /api/cloud/connect-finalize  { code, codeVerifier? }
 *
 * Browser-side completion of the connect popup flow. The dashboard
 * popup page `/cloud-connect-callback` reads the PKCE verifier from
 * localStorage and POSTs `{code, codeVerifier}` here (cross-origin in
 * the split-port self-hosted layout — CORS allows the dashboard
 * origin), where we run the SaaS code exchange and store the bearer.
 */
export async function connectFinalize(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req
    .json<{ code?: string; codeVerifier?: string }>()
    .catch(() => ({} as { code?: string; codeVerifier?: string }));
  if (!body.code) {
    return c.json({ error: "code is required" }, 400);
  }
  try {
    const { exchangeCodeWithCloud, storeCloudSession } = await import(
      "../../lib/cloud-auth-proxy"
    );
    const data = await exchangeCodeWithCloud(body.code, body.codeVerifier);
    if (!data) {
      return c.json(
        { error: "Could not verify with Openship Cloud" },
        401,
      );
    }
    await storeCloudSession(ctx.userId, data.sessionToken);
    return c.json({ ok: true });
  } catch (err) {
    console.error(
      `[cloud-connect-finalize] unexpected error: ${safeErrorMessage(err)}`,
    );
    return c.json({ error: safeErrorMessage(err) }, 500);
  }
}

