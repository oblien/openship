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

import type { Context } from "hono";
import { Oblien } from "@repo/adapters";
import { repos } from "@repo/db";
import { getRequestContext } from "../../lib/request-context";
import { audit, auditContextFrom } from "../../lib/audit";
import { cloudClient } from "@repo/platform/engine/lib/cloud/client";
import { getCloudConnectionStatusForOrg } from "@repo/platform/engine/lib/cloud/session";
import { safeErrorMessage } from "@repo/core";

// ─── Cloud workspaces / drift ────────────────────────────────────────────────

/**
 * GET /api/cloud/workspaces
 *
 * The recovery + drift primitive. Lists every workspace in the
 * active organization's owner namespace on Oblien, joins against
 * local `project.cloud_workspace_id` for the active org, returns:
 *
 *   - workspaces[]      every workspace owned by the org on cloud,
 *                       annotated with the local project (if any)
 *                       it's bound to
 *   - orphanedCloud[]   workspaces with no matching local project —
 *                       these surface in the Import wizard
 *   - orphanedLocal[]   local projects whose cloud_workspace_id is
 *                       no longer on cloud (deleted from Oblien
 *                       directly, or never existed) — surface as a
 *                       red badge with "Re-deploy" / "Delete local"
 *
 * Runs entirely on the local API. SaaS is touched only to mint the
 * namespace token through the org-owner cloud link (whichever member
 * of the org linked cloud). This means every member of the org sees
 * the same workspace list, and `connected: false` is returned only
 * when NO member of the org has linked cloud — not when the calling
 * user personally hasn't linked.
 *
 * Oblien enforces namespace isolation natively, so the listing
 * returned here is exactly the set of workspaces the org is allowed
 * to see.
 */
export async function listWorkspaces(c: Context) {
  const ctx = getRequestContext(c);

  const tokenResult = await cloudClient({ organizationId: ctx.organizationId })
    .token()
    .catch(() => null);
  if (!tokenResult) {
    return c.json({
      connected: false,
      workspaces: [],
      orphanedCloud: [],
      orphanedLocal: [],
    });
  }

  let cloudWorkspaces: Array<{
    id: string;
    slug?: string | null;
    name?: string;
    status: string;
    namespace?: string;
    createdAt: string;
    updatedAt: string;
  }>;
  try {
    const oblien = new Oblien({ token: tokenResult.token });
    const result = await oblien.workspaces.list({ limit: 200 });
    cloudWorkspaces = (result.workspaces as Array<{
      id: string;
      slug?: string | null;
      name?: string;
      status: string;
      namespace?: string;
      created_at: string;
      updated_at: string;
    }>).map((w) => ({
      id: w.id,
      slug: w.slug ?? null,
      name: w.name,
      status: w.status,
      namespace: w.namespace,
      createdAt: w.created_at,
      updatedAt: w.updated_at,
    }));
  } catch (err) {
    console.error(
      `[cloud-workspaces] Oblien list failed: ${safeErrorMessage(err)}`,
    );
    return c.json(
      {
        connected: true,
        error: "Could not list workspaces from Openship Cloud",
        workspaces: [],
        orphanedCloud: [],
        orphanedLocal: [],
      },
      502,
    );
  }

  // Pull local projects targeting cloud for this org.
  const localProjects = await repos.project
    .listCloudProjectsByOrganization(ctx.organizationId)
    .catch(() => [] as Array<{ id: string; name: string; slug: string; cloudWorkspaceId: string | null }>);

  const localByWorkspace = new Map<string, typeof localProjects[number]>();
  for (const p of localProjects) {
    if (p.cloudWorkspaceId) localByWorkspace.set(p.cloudWorkspaceId, p);
  }
  const cloudWorkspaceIds = new Set(cloudWorkspaces.map((w) => w.id));

  const workspaces = cloudWorkspaces.map((w) => ({
    ...w,
    localProject: localByWorkspace.get(w.id)
      ? {
          id: localByWorkspace.get(w.id)!.id,
          name: localByWorkspace.get(w.id)!.name,
          slug: localByWorkspace.get(w.id)!.slug,
        }
      : null,
  }));

  const orphanedCloud = cloudWorkspaces.filter((w) => !localByWorkspace.has(w.id));

  const orphanedLocal = localProjects.filter(
    (p) => p.cloudWorkspaceId && !cloudWorkspaceIds.has(p.cloudWorkspaceId),
  );

  return c.json({
    connected: true,
    namespace: tokenResult.namespace,
    workspaces,
    orphanedCloud,
    orphanedLocal,
  });
}

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

