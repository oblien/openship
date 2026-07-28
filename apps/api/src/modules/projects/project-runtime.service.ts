/**
 * Project runtime service - logs, enable/disable (start/stop).
 */

import { repos } from "@repo/db";
import { NotFoundError, ValidationError } from "@repo/core";
import type { LogEntry } from "@repo/adapters";
import { resolveDeploymentRuntime } from "../../lib/deployment-runtime";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import { syncManagedEdgeRoutes, edgeUnsyncedWarning } from "../../lib/managed-edge-proxy";
import { resolveManagedHostname } from "../../lib/routing-domains";

// ─── Runtime logs ────────────────────────────────────────────────────────────

export async function getRuntimeLogs(
  projectId: string,
  organizationId: string,
  tail?: number,
) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  if (!p.activeDeploymentId) {
    throw new NotFoundError("No active deployment for project", projectId);
  }

  const dep = await repos.deployment.findById(p.activeDeploymentId);
  if (!dep?.containerId) {
    throw new NotFoundError("No running container for project", projectId);
  }

  const { runtime } = await resolveDeploymentRuntime(dep);
  return runtime.getRuntimeLogs(dep.containerId, tail);
}

export async function streamRuntimeLogs(
  projectId: string,
  organizationId: string,
  onLog: (entry: LogEntry) => void,
  opts?: { tail?: number },
) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  if (!p.activeDeploymentId) {
    throw new NotFoundError("No active deployment for project", projectId);
  }

  const dep = await repos.deployment.findById(p.activeDeploymentId);
  if (!dep?.containerId) {
    throw new NotFoundError("No running container for project", projectId);
  }

  const { runtime, serverId } = await resolveDeploymentRuntime(dep);
  const cleanup = await runtime.streamRuntimeLogs(dep.containerId, onLog, opts);
  return { cleanup, serverId };
}

// ─── Enable / Disable ────────────────────────────────────────────────────────

export async function enableProject(projectId: string, organizationId: string) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  if (!p.activeDeploymentId) {
    throw new ValidationError("No deployment to enable - deploy first");
  }

  const dep = await repos.deployment.findById(p.activeDeploymentId);
  if (!dep?.containerId) {
    throw new ValidationError("No container found for active deployment");
  }

  const { runtime } = await resolveDeploymentRuntime(dep);
  await runtime.start(dep.containerId);
  return { success: true, message: "Project enabled" };
}

export async function disableProject(projectId: string, organizationId: string) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  if (!p.activeDeploymentId) {
    return { success: true, message: "No active deployment" };
  }

  const dep = await repos.deployment.findById(p.activeDeploymentId);
  if (!dep?.containerId) {
    return { success: true, message: "No container to stop" };
  }

  const { runtime } = await resolveDeploymentRuntime(dep);
  await runtime.stop(dep.containerId);
  return { success: true, message: "Project disabled" };
}

/**
 * Retry the managed free-domain (*.opsh.io) edge-proxy sync WITHOUT a rebuild.
 *
 * A deploy can come up live on the server yet fail to wire its free .opsh.io
 * URL through Openship Cloud's edge (target unreachable on :80, ownership not
 * yet verified, slug taken). That's surfaced as "Action Required"
 * (`meta.edgeUnsynced`); this re-runs just the edge sync for the project's
 * managed domains and, on full success, clears the warning so the project reads
 * "Live" again. Best-effort per domain — returns the failures instead of
 * throwing so the UI can re-surface the same guidance.
 */
export async function retryProjectRouting(
  projectId: string,
  organizationId: string,
): Promise<{ ok: boolean; warning?: string }> {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  const { ok, failures } = await syncProjectManagedEdge(p, organizationId);
  if (!ok) return { ok: false, warning: edgeUnsyncedWarning(failures, "retry") };
  return { ok: true };
}

/**
 * Core managed free-domain (*.opsh.io) edge reconciler, shared by the deploy
 * "retry routing" action and the live domain edit path — both need the SAME
 * idempotent slug→target upsert plus routing-warning bookkeeping.
 *
 *   - no managed domains  → clear any stale warning, ok.
 *   - all succeed         → clear the warning (project reads "Live" again).
 *   - any fail            → return the failures; when `markOnFailure`, persist
 *                           `meta.edgeUnsynced` so the project surfaces
 *                           "Action Required" / Retry. The edit path sets it
 *                           because the flag is the ONLY way the UI learns a
 *                           just-edited free URL is dead; retry leaves it as-is
 *                           (the deploy already set it).
 *
 * Best-effort per domain — never throws on a sync failure; returns the list.
 */
export async function syncProjectManagedEdge(
  project: NonNullable<Awaited<ReturnType<typeof repos.project.findById>>>,
  organizationId: string,
  opts: { markOnFailure?: boolean } = {},
): Promise<{ ok: boolean; failures: string[] }> {
  const dep = project.activeDeploymentId
    ? await repos.deployment.findById(project.activeDeploymentId)
    : null;
  const serverId = (dep?.meta as { serverId?: string } | null)?.serverId ?? undefined;

  const targets = (await repos.domain.listByProject(project.id))
    .map((d) => ({ hostname: d.hostname, ...resolveManagedHostname(d.hostname) }))
    .filter((m) => m.isManaged && m.subdomain)
    .map((m) => ({ hostname: m.hostname, subdomain: m.subdomain! }));

  // No free .opsh.io routes → nothing to sync; treat as resolved.
  if (targets.length === 0) {
    await clearRoutingWarning(dep);
    return { ok: true, failures: [] };
  }

  // Same edge sync the deploy pipeline runs — re-invoking it is idempotent
  // (the SaaS upserts the slug→target route), so a retry/edit can't duplicate.
  const { failures } = await syncManagedEdgeRoutes(targets, { organizationId, serverId });
  if (failures.length > 0) {
    if (opts.markOnFailure) await markRoutingWarning(dep, edgeUnsyncedWarning(failures, "retry"));
    return { ok: false, failures };
  }

  await clearRoutingWarning(dep);
  return { ok: true, failures: [] };
}

/** Drop the routing-unsynced markers from the active deployment's meta so the
 *  project no longer reads "Action Required" after a successful re-sync. */
async function clearRoutingWarning(
  dep: Awaited<ReturnType<typeof repos.deployment.findById>> | null,
): Promise<void> {
  if (!dep) return;
  const meta = { ...((dep.meta as Record<string, unknown> | null) ?? {}) };
  if (!("edgeUnsynced" in meta) && !("deployWarning" in meta)) return;
  delete meta.edgeUnsynced;
  delete meta.deployWarning;
  await repos.deployment.updateStatus(dep.id, dep.status, { meta });
}

/** Set the routing-unsynced markers so the project reads "Action Required" and
 *  the dashboard exposes "Retry routing" (see `routingUnsynced` in enrichProject). */
async function markRoutingWarning(
  dep: Awaited<ReturnType<typeof repos.deployment.findById>> | null,
  warning: string,
): Promise<void> {
  if (!dep) return;
  const meta = { ...((dep.meta as Record<string, unknown> | null) ?? {}) };
  meta.edgeUnsynced = true;
  meta.deployWarning = warning;
  await repos.deployment.updateStatus(dep.id, dep.status, { meta });
}


