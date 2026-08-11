/**
 * Updates HTTP handlers — the one "check for updates" surface, org-scoped.
 * `GET /updates` is read-through (it polls whatever the cache can't answer), so
 * it never under-reports on a cold cache; `POST /updates/scan` forces a full
 * re-poll. The scheduled `updates:scan` job keeps rows warm ahead of both.
 */

import type { Context } from "hono";
import { getRequestContext } from "../../lib/request-context";
import { param } from "../../lib/controller-helpers";
import {
  applyProjectUpdate,
  listOrganizationUpdates,
  scanOrganizationUpdates,
} from "./updates.service";

/** GET /api/updates?behind=1 — update status for every project in the caller's org. */
export async function listUpdates(c: Context) {
  const ctx = getRequestContext(c);
  const behindOnly = ["1", "true"].includes((c.req.query("behind") ?? "").toLowerCase());
  const data = await listOrganizationUpdates(ctx, { behindOnly });
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
