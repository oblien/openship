/**
 * Updates HTTP handlers — the one "check for updates" surface, org-scoped.
 * Reads the cached scan (`GET /updates`) and triggers an on-demand rescan
 * (`POST /updates/scan`). The scheduled `updates:scan` job refreshes the cache
 * in the background; this endpoint lets the dashboard force a fresh sweep.
 */

import type { Context } from "hono";
import { getRequestContext } from "../../lib/request-context";
import { param } from "../../lib/controller-helpers";
import {
  applyProjectUpdate,
  listOrganizationUpdates,
  scanOrganizationUpdates,
} from "./updates.service";

/** GET /api/updates?behind=1 — cached update statuses for the caller's org. */
export async function listUpdates(c: Context) {
  const ctx = getRequestContext(c);
  const behindOnly = ["1", "true"].includes((c.req.query("behind") ?? "").toLowerCase());
  const data = await listOrganizationUpdates(ctx.organizationId, { behindOnly });
  return c.json({ data });
}

/** POST /api/updates/scan — force a fresh sweep, return a summary. */
export async function triggerScan(c: Context) {
  const ctx = getRequestContext(c);
  const summary = await scanOrganizationUpdates(ctx, ctx.organizationId);
  return c.json({ data: summary });
}

/** POST /api/updates/:projectId/apply — apply the available update to a project. */
export async function applyUpdate(c: Context) {
  const ctx = getRequestContext(c);
  const result = await applyProjectUpdate(ctx, param(c, "projectId"));
  return c.json({ data: result });
}
