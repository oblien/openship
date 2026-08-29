/**
 * Health controller — what the project page's Health tab reads.
 *
 *   GET /api/projects/:id/incidents
 *
 * Self-hosted only (mounted behind localOnly), because the watcher that writes
 * these rows is self-hosted only.
 *
 * Two things beyond the rows themselves, both there to stop an empty tab from
 * being misread as "all good":
 *
 *   - `watching`: whether the health-watch job is actually enabled. It is an
 *     operator-facing switch (Jobs module) and it is also the global mute for
 *     these alerts — with it off, no incident can ever appear here.
 *   - `serverUnreachable`: the box's own open incident. While a server is
 *     unreachable the watcher deliberately freezes every project on it — nothing
 *     is observed, so nothing opens or resolves — and the project's own rows go
 *     stale. Surfacing the server incident explains the staleness.
 */

import type { Context } from "hono";
import { repos } from "@repo/db";
import { getRequestContext } from "../../lib/request-context";
import { param } from "../../lib/controller-helpers";

/** How much resolved history the tab shows. Matches the prune window. */
const HISTORY_DAYS = 30;

export async function listProjectIncidents(c: Context) {
  const organizationId = getRequestContext(c).organizationId;
  const project = await repos.project.findById(param(c, "id"));
  if (!project || project.organizationId !== organizationId) {
    return c.json({ error: "Project not found" }, 404);
  }

  const rows = await repos.serviceIncident.listForProject(project.id, 100);
  const cutoff = Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;

  const open = rows.filter((r) => r.status === "open");
  const resolved = rows.filter(
    (r) => r.status !== "open" && (r.resolvedAt?.getTime() ?? 0) >= cutoff,
  );

  // The workload runs where its active deployment put it; a project with no
  // recorded server is on the box the control plane itself runs on.
  const dep = project.activeDeploymentId
    ? await repos.deployment.findById(project.activeDeploymentId)
    : null;
  const serverId = (dep?.meta as { serverId?: string } | null)?.serverId ?? null;
  const serverUnreachable = serverId ? await repos.serviceIncident.findOpenForServer(serverId) : null;

  const job = await repos.job.findByKey("services:health-watch");

  return c.json({
    open,
    resolved,
    historyDays: HISTORY_DAYS,
    serverUnreachable: serverUnreachable ?? null,
    watching: job ? job.enabled : false,
  });
}
