/**
 * Untracked edge vhosts — the operator-facing read + the one-at-a-time cleanup.
 *
 * Edge config lives on the host and can outlive its DB rows: record-only delete
 * ("Remove from Openship only") keeps the vhost serving on purpose. That leftover
 * is invisible — a dead PROXY vhost at least 502s, but a STATIC one keeps serving
 * the removed project's files with a 200, potentially on a hostname since claimed
 * by someone else. This is the surface that finds them.
 *
 * All logic is in lib/edge-orphans.service.ts; this is request/response only.
 */

import type { Context } from "hono";

import { removeEdgeOrphan, scanEdgeOrphans } from "../../lib/edge-orphans.service";

/** GET /system/edge/untracked — vhosts the local edge serves that Openship doesn't track. */
export async function listUntrackedEdgeSites(c: Context) {
  const scan = await scanEdgeOrphans();
  return c.json({ data: scan });
}

/**
 * POST /system/edge/untracked/remove — stop serving ONE named hostname.
 *
 * Body: `{ hostname }`. Deliberately not a sweep: record-only delete's contract is
 * that nothing on the server is touched, so removing config in bulk would break the
 * very promise that produced these. The service re-scans and refuses any hostname
 * that isn't still reported untracked, so a stale list can't take down a live
 * domain. Built files are left on disk — they may be a rollback target.
 */
export async function removeUntrackedEdgeSite(c: Context) {
  const body = await c.req.json<{ hostname?: string }>().catch(() => ({}) as { hostname?: string });
  const hostname = body.hostname?.trim();
  if (!hostname) {
    return c.json({ error: "`hostname` is required", code: "HOSTNAME_REQUIRED" }, 400);
  }

  const result = await removeEdgeOrphan(hostname);
  if (!result.removed) {
    // The guard rejection ("not an untracked vhost") is a conflict, not a server
    // error: the caller asked to remove something we won't remove.
    return c.json({ error: result.reason ?? "Could not remove", code: "EDGE_ORPHAN_REFUSED" }, 409);
  }
  return c.json({ data: { removed: true, hostname } });
}
