/**
 * Project runtime service - logs, enable/disable (start/stop).
 */

import { repos } from "@repo/db";
import { NotFoundError, ValidationError } from "@repo/core";
import { checkEdge, edgeProxy } from "@repo/adapters";
import type { LogEntry, ImportedSite } from "@repo/adapters";
import { resolveDeploymentRuntime } from "../../lib/deployment-runtime";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import { syncManagedEdgeRoutes, edgeUnsyncedWarning } from "../../lib/managed-edge-proxy";
import { resolveManagedHostname } from "../../lib/routing-domains";
import { sshManager } from "../../lib/ssh-manager";
import { applyProjectRouting } from "../domains/routing-apply.service";
import { reapplyProjectLiveRoutes } from "../domains/project-route.service";

// ─── Active-container resolution ───────────────────────────────────────────────

/**
 * Pick the container a project-level read-path op (logs / start / stop) should
 * act on, from the active deployment's recorded container and its per-service
 * rows.
 *
 * A single-app deployment (no service rows) records the app container directly,
 * so `recordedContainerId` is authoritative. A COMPOSE deployment's recorded
 * container is a best-effort primary that historically mis-resolved to a
 * dependency (the db an app dependsOn) or, for an all-carried deploy, to the
 * "compose" sentinel — so prefer the EXPOSED service's live container, the one
 * the project's public route points at. Pure + exported for testing.
 */
export function pickActiveContainerId(args: {
  recordedContainerId: string | null;
  serviceDeployments: ReadonlyArray<{ serviceId: string; containerId: string | null }>;
  exposedServiceIds: ReadonlySet<string>;
}): string | null {
  const { recordedContainerId, serviceDeployments, exposedServiceIds } = args;
  // "compose" is the sentinel an all-carried deploy recorded — never a real id.
  const recorded =
    recordedContainerId && recordedContainerId !== "compose" ? recordedContainerId : null;
  if (serviceDeployments.length === 0) return recorded;
  const exposedApp = serviceDeployments.find(
    (sd) => sd.containerId && exposedServiceIds.has(sd.serviceId),
  );
  if (exposedApp?.containerId) return exposedApp.containerId;
  // Nothing exposed resolvable — keep the recorded primary, else any live
  // service container (a usable target beats a misleading "no container").
  return recorded ?? serviceDeployments.find((sd) => sd.containerId)?.containerId ?? null;
}

/**
 * Reconcile the active deployment's recorded container against reality before a
 * read-path op trusts it. DB-only, no docker probe.
 *
 * Gate on `meta.serviceDeploymentMode` — written into the deployment snapshot at
 * CREATE time (the field `build-status.service.ts` trusts to classify a
 * deployment), so it is present regardless of HOW the deploy settled. This is
 * deliberately NOT `meta.composeDeployment`, which onSuccess's metaPatch writes
 * ONLY on the happy path: a compose deploy that settled via the RECONCILE path
 * (connection loss) never gets that marker, and if the loss hit before the
 * exposed app came up its recorded parent is the topo-first db — so gating on the
 * success-only marker left the read path acting on the db again. `serviceDeploymentMode`
 * is `"single"` (or the caller's explicit single-app value) only for single-app
 * deploys; compose always resolves to `"services"`, and an undefined value falls
 * through to the reconcile (harmless — a single-app deploy has no service rows,
 * so `pickActiveContainerId` returns the recorded id unchanged).
 */
export async function resolveActiveContainerId(
  projectId: string,
  dep: { id: string; containerId: string | null; meta: unknown },
): Promise<string | null> {
  const mode = (dep.meta as { serviceDeploymentMode?: string } | null)?.serviceDeploymentMode;
  if (mode === "single") return dep.containerId ?? null;

  const [serviceRows, services] = await Promise.all([
    repos.service.listByDeployment(dep.id).catch(() => []),
    repos.service.listByProject(projectId).catch(() => []),
  ]);
  return pickActiveContainerId({
    recordedContainerId: dep.containerId,
    serviceDeployments: serviceRows,
    exposedServiceIds: new Set(services.filter((s) => s.exposed).map((s) => s.id)),
  });
}

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
  const containerId = dep ? await resolveActiveContainerId(projectId, dep) : null;
  if (!dep || !containerId) {
    throw new NotFoundError("No running container for project", projectId);
  }

  const { runtime } = await resolveDeploymentRuntime(dep);
  return runtime.getRuntimeLogs(containerId, tail);
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
  const containerId = dep ? await resolveActiveContainerId(projectId, dep) : null;
  if (!dep || !containerId) {
    throw new NotFoundError("No running container for project", projectId);
  }

  const { runtime, serverId } = await resolveDeploymentRuntime(dep);
  const cleanup = await runtime.streamRuntimeLogs(containerId, onLog, opts);
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
  const containerId = dep ? await resolveActiveContainerId(projectId, dep) : null;
  if (!dep || !containerId) {
    throw new ValidationError("No container found for active deployment");
  }

  const { runtime } = await resolveDeploymentRuntime(dep);
  await runtime.start(containerId);
  // Cleared AFTER the start succeeded — the mirror of disableProject's ordering.
  // Clearing first would tell the health watch to expect a container that hasn't
  // come up yet.
  await repos.project.update(projectId, { disabledAt: null });
  return { success: true, message: "Project enabled" };
}

/**
 * Stop a project's container and RECORD that a human meant to.
 *
 * The `disabled_at` write is not bookkeeping — it is the only place that
 * intent exists. Docker cannot tell "the operator turned this off" from "it
 * crashed and stayed down": both are an exited container. This used to write
 * nothing at all, which left the health watch structurally unable to stay quiet
 * about a deliberately-stopped project.
 */
export async function disableProject(projectId: string, organizationId: string) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  if (!p.activeDeploymentId) {
    return { success: true, message: "No active deployment" };
  }

  const dep = await repos.deployment.findById(p.activeDeploymentId);
  const containerId = dep ? await resolveActiveContainerId(projectId, dep) : null;
  if (!dep || !containerId) {
    return { success: true, message: "No container to stop" };
  }

  // Marked BEFORE the stop, deliberately: a poll that lands between the two must
  // see the intent, not a container that just went down for no recorded reason.
  await repos.project.update(projectId, { disabledAt: new Date() });
  const { runtime } = await resolveDeploymentRuntime(dep);
  await runtime.stop(containerId);
  return { success: true, message: "Project disabled" };
}

/**
 * Retry ("Reroute") routing WITHOUT a rebuild — a real repair, not just a
 * free-domain re-sync.
 *
 * A deploy that mis-resolved its target (e.g. a fresh/partial snapshot that fell
 * back to "local") both fails to wire the project's routes AND nulls its verified
 * custom-domain ports, which regressed the Access URL to localhost. This action
 * heals that in place:
 *
 *   1. Re-point the active deployment at the DURABLE server binding
 *      (`project.serverId`) — a snapshot missing `meta.serverId` is what let
 *      routing resolve to "local".
 *   2. Restore any verified custom domain whose port was nulled, reading the port
 *      from what the edge is ACTUALLY serving. Safe-only: no live upstream ⇒ the
 *      row is left unchanged (a genuinely domain-less project stays "Local").
 *   3. Re-apply the project's LIVE routes (custom + free) reload-free.
 *   4. Reconcile managed `*.opsh.io` edge routes and clear the "Action Required"
 *      warning — only on full success.
 *   5. Verify the edge is SERVING what steps 1-4 wrote, so a box whose edge never
 *      bound :80 can't answer this action with "Live" (see `edgeServingWarning`).
 *
 * Best-effort throughout; returns the failure instead of throwing so the UI can
 * re-surface the same guidance.
 */
export async function retryProjectRouting(
  projectId: string,
  organizationId: string,
): Promise<{ ok: boolean; warning?: string }> {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  // Cloud manages its own ingress — there is no server edge to repair here.
  if (p.cloudWorkspaceId) return { ok: true };

  const dep = p.activeDeploymentId
    ? await repos.deployment.findById(p.activeDeploymentId)
    : null;

  await repairDeploymentServerBinding(p, dep).catch(() => {});

  const serverId = p.serverId ?? (dep?.meta as { serverId?: string } | null)?.serverId ?? undefined;
  await restoreCustomPortsFromEdge(p, serverId).catch(() => {});

  // Live re-apply is best-effort, but its failure must NOT clear the warning.
  let applyOk = true;
  // `reapplyProjectLiveRoutes` FIRST, `applyProjectRouting` second — the two cover
  // different route shapes and retry has to heal all of them:
  //   - reapply → the per-domain surface: a single app's port target OR a static
  //     app's `/` served from a doc root (targetPath). `applyProjectRouting` is
  //     composite-only (`planCompositeRoute` needs 1 static + 1 server), so on its
  //     own it emitted NOTHING for a lone static app — the free URL 404'd forever
  //     because retry never rewrote the vhost the failed deploy left unwritten.
  //   - applyProjectRouting → layers the vercel composite overlay (`/api` → backend)
  //     back on for a monorepo. A no-op otherwise, and registerRoute is
  //     last-writer-wins per hostname, so running it after reapply can only add the
  //     backend location, never drop the frontend reapply just wrote.
  // `managedEdgeSyncedByCaller`: syncProjectManagedEdge below already covers every
  // managed hostname; letting reapply sync them too races its own follow-up (two
  // ACME challenges for one target, the second resetting the first's token).
  await reapplyProjectLiveRoutes(p, [], { managedEdgeSyncedByCaller: true }).catch(() => {
    applyOk = false;
  });
  await applyProjectRouting(projectId).catch(() => {
    applyOk = false;
  });

  // Reconciles *.opsh.io and clears the warning on its own success (including the
  // no-managed-domains case). syncProjectManagedEdge re-reads the deployment, so
  // it sees the serverId we just repaired.
  const { ok, failures } = await syncProjectManagedEdge(p, organizationId);
  if (!ok) return { ok: false, warning: edgeUnsyncedWarning(failures, "retry") };

  if (!applyOk) {
    const warning = "Couldn't re-apply the project's routes at the edge — retry once the server is reachable.";
    const fresh = p.activeDeploymentId ? await repos.deployment.findById(p.activeDeploymentId) : null;
    await markRoutingWarning(fresh, warning).catch(() => {});
    return { ok: false, warning };
  }

  // Last: every step above writes CONFIGURATION, and a written route is not a served
  // one. An edge crash-looping on `bind() … Address already in use` accepts every
  // vhost write, answers the cloud-side sync fine, and serves nothing — so this
  // action reported "Live" while all of the project's URLs were dead, which is the
  // opposite of what the operator pressed it to find out.
  const edgeWarning = await edgeServingWarning(p, serverId);
  if (edgeWarning) {
    const fresh = p.activeDeploymentId ? await repos.deployment.findById(p.activeDeploymentId) : null;
    await markRoutingWarning(fresh, edgeWarning).catch(() => {});
    return { ok: false, warning: edgeWarning };
  }
  return { ok: true };
}

/**
 * "Are this project's routes actually being served?" — null when yes (or when the
 * question doesn't apply), else the operator-facing reason.
 *
 * Deliberately `checkEdge`, not a private probe: it is the one composed verdict
 * (container present → not crash-looping → listening on :80 → responsive) and it
 * quotes the container's own `[emerg]`, so this button, the Components tab and the
 * home attention card all name the same cause instead of three guesses.
 *
 * Two gates keep it from inventing failures:
 *   - no server (local/cloud target) → not our edge's question;
 *   - no domains → the project has nothing at the edge to lose, so the edge's state
 *     is irrelevant to whether ITS routing is synced.
 * An unreachable box also returns null: "couldn't ask" is not "not serving", and the
 * route-apply steps above already report a server they couldn't reach.
 */
async function edgeServingWarning(
  project: NonNullable<Awaited<ReturnType<typeof repos.project.findById>>>,
  serverId: string | undefined,
): Promise<string | null> {
  if (!serverId) return null;
  const domains = await repos.domain.listByProject(project.id).catch(() => []);
  if (domains.length === 0) return null;
  try {
    const status = await sshManager.withExecutor(serverId, (executor) => checkEdge(executor));
    return status.healthy ? null : `Routes are written but not being served: ${status.message}`;
  } catch {
    return null;
  }
}

/** The upstream host port a live vhost forwards to — the root ("/") location's
 *  when present (the app port), else the first parseable upstream. Null for a
 *  static docroot or an unparseable upstream, i.e. no safe port to restore. */
function liveUpstreamPort(site: ImportedSite): number | null {
  const upstreams =
    site.routes ?? (site.target.kind === "proxy" ? [{ path: "/", url: site.target.url }] : []);
  const ordered = [
    ...upstreams.filter((u) => u.path === "/"),
    ...upstreams.filter((u) => u.path !== "/"),
  ];
  for (const up of ordered) {
    try {
      const port = Number(new URL(up.url).port);
      if (Number.isFinite(port) && port > 0) return port;
    } catch {
      // Unparseable upstream — skip, try the next.
    }
  }
  return null;
}

/** Re-point the active deployment's snapshot at the durable server binding when
 *  it drifted. A missing `meta.serverId`/`deployTarget` is what let a redeploy
 *  resolve to "local"; stamping them makes resolveEffectiveTarget agree again. */
async function repairDeploymentServerBinding(
  project: NonNullable<Awaited<ReturnType<typeof repos.project.findById>>>,
  dep: Awaited<ReturnType<typeof repos.deployment.findById>> | null,
): Promise<void> {
  if (!dep || !project.serverId) return;
  const meta = { ...((dep.meta as Record<string, unknown> | null) ?? {}) };
  if (meta.serverId === project.serverId && meta.deployTarget) return;
  meta.serverId = project.serverId;
  if (!meta.deployTarget) meta.deployTarget = "server";
  await repos.deployment.updateStatus(dep.id, dep.status, { meta });
}

/** Restore verified custom domains whose port was nulled, from what the edge is
 *  actually serving. Safe-only: a row with no live upstream (or no server) is
 *  left untouched — we never fabricate a port. */
async function restoreCustomPortsFromEdge(
  project: NonNullable<Awaited<ReturnType<typeof repos.project.findById>>>,
  serverId: string | undefined,
): Promise<void> {
  if (!serverId) return;
  const candidates = (await repos.domain.listByProject(project.id)).filter(
    (d) =>
      !d.serviceId &&
      d.domainType === "custom" &&
      d.verified &&
      (d.targetPort ?? null) === null &&
      !d.targetPath,
  );
  if (candidates.length === 0) return;

  await sshManager.withExecutor(serverId, async (executor) => {
    const proxy = await edgeProxy(executor);
    if (!proxy) return;
    for (const row of candidates) {
      const site = await proxy.siteFor(row.hostname).catch(() => null);
      const port = site ? liveUpstreamPort(site) : null;
      if (port != null) await repos.domain.update(row.id, { targetPort: port });
    }
  });
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


