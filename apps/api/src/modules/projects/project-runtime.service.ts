/**
 * Project runtime service - logs, enable/disable (start/stop).
 */

import { repos } from "@repo/db";
import { AppError, NotFoundError, ValidationError, safeErrorMessage } from "@repo/core";
import { checkEdge, edgeProxy } from "@repo/adapters";
import type { LogEntry, ImportedSite, RuntimeAdapter } from "@repo/adapters";
import {
  deploymentContainerIds,
  resolveDeploymentRuntimeForRead,
  withDeploymentPlatform,
  withDeploymentRuntime,
} from "../../lib/deployment-runtime";
import { isAbsent, isAlreadyInState } from "../../lib/remote-state";
import { assertNotControlPlane, assertResourceInOrg } from "../../lib/controller-helpers";
import { syncManagedEdgeRoutes, edgeUnsyncedWarning } from "../../lib/managed-edge-proxy";
import { reconcileServerEdge } from "../../lib/edge-reconcile";
import { resolveManagedHostname } from "../../lib/routing-domains";
import { sshManager } from "../../lib/ssh-manager";
import { withLiveProjectRuntimeMutation } from "../../lib/project-runtime-lock";
import { applyProjectRouting } from "../domains/routing-apply.service";
import { reapplyProjectLiveRoutes } from "../domains/project-route.service";
import { deploymentWorkload } from "../deployments/deployment-class";
import { livePrimaryContainerId } from "../services/service-container";

// ─── Runtime logs ────────────────────────────────────────────────────────────

export async function getRuntimeLogs(projectId: string, organizationId: string, tail?: number) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  if (!p.activeDeploymentId) {
    throw new NotFoundError("No active deployment for project", projectId);
  }

  const dep = await repos.deployment.findById(p.activeDeploymentId);
  if (!dep) {
    throw new NotFoundError("No running container for project", projectId);
  }

  // Resolved live inside the runtime, not read off `dep.containerId`: on a
  // multi-service project that column names one service, and in dependency order
  // that was the database (#498) — so "the project's logs" were postgres's.
  return withDeploymentRuntime(dep, async (runtime) => {
    const containerId = await livePrimaryContainerId(runtime, dep);
    if (!containerId) {
      throw new NotFoundError("No running container for project", projectId);
    }
    return runtime.getRuntimeLogs(containerId, tail);
  });
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
  if (!dep) {
    throw new NotFoundError("No running container for project", projectId);
  }

  // NOT withDeploymentRuntime: the transport has to outlive this call, so the
  // runtime is disposed in the stream's cleanup instead — same shape as
  // streamServiceRuntimeLogs. Disposing here would kill the live stream.
  const { runtime, serverId } = await resolveDeploymentRuntimeForRead(dep);
  const containerId = await livePrimaryContainerId(runtime, dep).catch(() => null);
  if (!containerId) {
    void Promise.resolve(runtime.dispose?.()).catch(() => {});
    throw new NotFoundError("No running container for project", projectId);
  }
  const stop = await runtime.streamRuntimeLogs(containerId, onLog, opts);
  const cleanup = () => {
    try {
      stop();
    } finally {
      void Promise.resolve(runtime.dispose?.()).catch(() => {});
    }
  };
  return { cleanup, serverId };
}

// ─── Enable / Disable ────────────────────────────────────────────────────────

type ProjectRow = NonNullable<Awaited<ReturnType<typeof repos.project.findById>>>;
type DeploymentRow = NonNullable<Awaited<ReturnType<typeof repos.deployment.findById>>>;

/**
 * A project the EDGE serves rather than a container runtime — a self-hosted
 * static site.
 *
 * `!hasServer` + non-cloud is the signal the deploy pipeline itself branches on
 * (`resolveDeployRouting` → deployMode "static-file-serve"), and it is why
 * pause/resume could never work through the runtime here: such a deployment's
 * `containerId` is a release DIRECTORY on the host (see
 * `resolveDeploymentStaticRoot`), so `runtime.stop()` dials
 * `/containers//opt/openship/static/releases/<id>/stop` and the daemon answers 301
 * to the doubled slash — measured, not assumed, and it is neither `isAbsent` nor
 * `isAlreadyInState`, so both actions died on "(HTTP code 301) unexpected".
 *
 * Cloud statics are excluded because they already pause correctly one level up:
 * their containerId is a `page:` handle and CloudRuntime maps stop/start onto
 * pages.disable/enable — the same edge-level pause the branches below perform
 * against our own edge.
 */
function isEdgeServedStatic(
  project: Pick<ProjectRow, "hasServer" | "workloadType" | "cloudWorkspaceId">,
): boolean {
  // Only a STATIC workload is served by the edge as files. A worker shares
  // `hasServer=false` but is a real container with its own runtime lifecycle, so
  // route through the workload axis — not the legacy boolean — or a worker's
  // pause/resume would be (mis)handled as edge-route removal (#538-B).
  return deploymentWorkload(project) === "static" && !project.cloudWorkspaceId;
}

/**
 * Pause a static project: delete the vhosts that serve it.
 *
 * The edge IS the workload, so removing its routes is the only stop there is.
 * The free *.opsh.io route is deliberately LEFT registered on Cloud's edge —
 * deregistering releases the slug for anyone else to claim, which a reversible
 * pause must not do; requests for it still reach this box and now get the edge's
 * not-found page.
 *
 * Not best-effort, unlike routing on a deploy: nothing else takes this site down,
 * so a removal that failed has to reach the caller (which rolls the `disabled_at`
 * intent back) instead of reporting a pause that didn't happen. `removeRoute` is
 * safe to call either way — it is idempotent (rm -rf semantics) and restores the
 * vhost + rethrows if the reload fails.
 */
async function stopEdgeServing(project: Pick<ProjectRow, "id">, dep: DeploymentRow): Promise<void> {
  const hostnames = (await repos.domain.listByProject(project.id))
    .filter((d) => !d.serviceId)
    .map((d) => d.hostname);
  if (hostnames.length === 0) return;
  await withDeploymentPlatform(dep, async ({ routing }) => {
    for (const hostname of hostnames) {
      await routing.removeRoute(hostname);
    }
  });
}

export async function enableProject(projectId: string, organizationId: string) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);
  assertNotControlPlane(p);

  const result = await withLiveProjectRuntimeMutation(projectId, async (liveProject) => {
    assertResourceInOrg(liveProject, "Project", organizationId, projectId);
    assertNotControlPlane(liveProject);
    return enableLiveProject(liveProject, organizationId);
  });
  if (!result) throw new NotFoundError("Project", projectId);
  return result;
}

/** Enable is a remote runtime/route writer and therefore runs under teardown's lock. */
async function enableLiveProject(p: ProjectRow, organizationId: string) {
  const projectId = p.id;

  if (!p.activeDeploymentId) {
    throw new ValidationError("No deployment to enable - deploy first");
  }

  const dep = await repos.deployment.findById(p.activeDeploymentId);
  if (!dep) {
    throw new ValidationError("No container found for active deployment");
  }

  if (isEdgeServedStatic(p)) {
    // Deliberately `retryProjectRouting` rather than a second routing path: it is
    // already the action that re-applies a project's LIVE routes (a static
    // domain's doc root included), reconciles the managed *.opsh.io edge, and then
    // VERIFIES the edge is serving what it wrote — the exact inverse of
    // `stopEdgeServing`. It reports failures instead of throwing, so this is where
    // the resume decides they are fatal: same contract as a container whose start
    // failed, so the pause marker survives a resume that didn't take.
    const { ok, warning } = await retryProjectRouting(projectId, organizationId);
    if (!ok) {
      throw new AppError(
        warning ?? "Couldn't re-apply this project's routes — resume once the server is reachable.",
        502,
        "ROUTES_NOT_APPLIED",
      );
    }
    await repos.project.update(projectId, { disabledAt: null });
    return { success: true, message: "Project enabled" };
  }

  const containerIds = await deploymentContainerIds(dep);
  if (containerIds.length === 0) {
    throw new ValidationError("No container found for active deployment");
  }

  await withDeploymentRuntime(dep, async (runtime) => {
    for (const containerId of containerIds) {
      await startOne(runtime, containerId);
    }
  });
  // Cleared AFTER the start succeeded — the mirror of disableProject's ordering.
  // Clearing first would tell the health watch to expect a container that hasn't
  // come up yet.
  await repos.project.update(projectId, { disabledAt: null });
  return { success: true, message: "Project enabled" };
}

/**
 * Stop whatever serves a project — its containers, or the edge routes when the
 * edge is the workload (see `isEdgeServedStatic`) — and RECORD that a human meant
 * to.
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
  // Pausing the control plane means stopping the container that is handling this
  // request — it would answer with a dropped connection, not a result.
  assertNotControlPlane(p);

  const result = await withLiveProjectRuntimeMutation(projectId, async (liveProject) => {
    assertResourceInOrg(liveProject, "Project", organizationId, projectId);
    assertNotControlPlane(liveProject);
    return disableLiveProject(liveProject);
  });
  if (!result) throw new NotFoundError("Project", projectId);
  return result;
}

/** Disable is a remote runtime/route writer and therefore runs under teardown's lock. */
async function disableLiveProject(p: ProjectRow) {
  const projectId = p.id;

  if (!p.activeDeploymentId) {
    return { success: true, message: "No active deployment" };
  }

  const dep = await repos.deployment.findById(p.activeDeploymentId);
  if (!dep) {
    return { success: true, message: "No container to stop" };
  }
  // EVERY container, not just `dep.containerId`: on a compose project that column
  // names one service (or nothing), so pausing used to leave the rest running
  // while the project reported itself disabled.
  const edgeServed = isEdgeServedStatic(p);
  const containerIds = edgeServed ? [] : await deploymentContainerIds(dep);
  if (!edgeServed && containerIds.length === 0) {
    return { success: true, message: "No container to stop" };
  }

  // Marked BEFORE the stop, deliberately: a poll that lands between the two must
  // see the intent, not a container that just went down for no recorded reason.
  const previous = p.disabledAt ?? null;
  await repos.project.update(projectId, { disabledAt: new Date() });
  try {
    if (edgeServed) {
      await stopEdgeServing(p, dep);
    } else {
      await withDeploymentRuntime(dep, async (runtime) => {
        for (const containerId of containerIds) {
          await stopOne(runtime, containerId);
        }
      });
    }
  } catch (err) {
    // The intent write has to be undone when the workload did NOT stop.
    // Leaving it set was the worst of both worlds: the project read "disabled"
    // (and the health watch went quiet on it) while every container kept
    // serving, and `enableProject` refuses to clear the flag until a start
    // succeeds — so an unreachable box made the state permanent.
    await repos.project.update(projectId, { disabledAt: previous }).catch(() => {});
    throw err;
  }
  return { success: true, message: "Project disabled" };
}

/** Stop one container, treating "already stopped" and "already gone" as done.
 *  Everything else — above all an unreachable host — propagates. */
async function stopOne(runtime: RuntimeAdapter, containerId: string): Promise<void> {
  try {
    await runtime.stop(containerId);
  } catch (err) {
    if (isAlreadyInState(err) || isAbsent(err)) return;
    throw err;
  }
}

/** Start one container, treating "already running" as done. An ABSENT container
 *  is a real failure here — unlike a stop, there is nothing to converge on. */
async function startOne(runtime: RuntimeAdapter, containerId: string): Promise<void> {
  try {
    await runtime.start(containerId);
  } catch (err) {
    if (isAlreadyInState(err)) return;
    throw err;
  }
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
 *   2. Reconcile and health-check the target server's edge before issuing any
 *      route read/write. A missing or stopped edge is revived; an unrecoverable
 *      edge returns immediately with an actionable warning.
 *   3. Restore any verified custom domain whose port was nulled, reading the port
 *      from what the edge is ACTUALLY serving. Safe-only: no live upstream ⇒ the
 *      row is left unchanged (a genuinely domain-less project stays "Local").
 *   4. Re-apply the project's LIVE routes (custom + free) reload-free.
 *   5. Reconcile managed `*.opsh.io` edge routes and clear the "Action Required"
 *      warning — only on full success.
 *   6. Verify the edge is SERVING what steps 1-5 wrote, so a box whose edge never
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

  const result = await withLiveProjectRuntimeMutation(projectId, async (liveProject) => {
    // The first read above is the authorization boundary; this second assertion
    // protects the callback if ownership changed while it waited for teardown.
    assertResourceInOrg(liveProject, "Project", organizationId, projectId);
    return retryLiveProjectRouting(liveProject, organizationId);
  });
  return (
    result ?? {
      ok: false,
      warning: "Routing was not retried because the project is being deleted.",
    }
  );
}

/** The complete retry writer, entered only through the shared teardown lock. */
async function retryLiveProjectRouting(
  p: ProjectRow,
  organizationId: string,
): Promise<{ ok: boolean; warning?: string }> {
  const projectId = p.id;

  // Cloud manages its own ingress — there is no server edge to repair here.
  if (p.cloudWorkspaceId) return { ok: true };

  const dep = p.activeDeploymentId ? await repos.deployment.findById(p.activeDeploymentId) : null;

  await repairDeploymentServerBinding(p, dep).catch(() => {});

  const serverId = p.serverId ?? (dep?.meta as { serverId?: string } | null)?.serverId ?? undefined;

  // Route application reaches into openship-edge. Reconcile it BEFORE any route
  // read/write so a stopped or missing container is revived rather than leaving
  // docker exec/config reload calls to sit until the request timeout (#693).
  const edgeRecoveryWarning = await recoverProjectEdge(p, dep);
  if (edgeRecoveryWarning) {
    const fresh = p.activeDeploymentId
      ? await repos.deployment.findById(p.activeDeploymentId)
      : null;
    await markRoutingWarning(fresh, edgeRecoveryWarning).catch(() => {});
    return { ok: false, warning: edgeRecoveryWarning };
  }

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
    const warning =
      "Couldn't re-apply the project's routes at the edge — retry once the server is reachable.";
    const fresh = p.activeDeploymentId
      ? await repos.deployment.findById(p.activeDeploymentId)
      : null;
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
    const fresh = p.activeDeploymentId
      ? await repos.deployment.findById(p.activeDeploymentId)
      : null;
    await markRoutingWarning(fresh, edgeWarning).catch(() => {});
    return { ok: false, warning: edgeWarning };
  }
  return { ok: true };
}

/**
 * Ensure the edge serving this project's domains exists and is healthy before
 * retry touches its vhosts. Uses deployment-platform resolution so the same
 * repair works for this host and for an SSH target server.
 */
async function recoverProjectEdge(
  project: NonNullable<Awaited<ReturnType<typeof repos.project.findById>>>,
  dep: Awaited<ReturnType<typeof repos.deployment.findById>> | null,
): Promise<string | null> {
  if (!dep) return null;
  const domains = await repos.domain.listByProject(project.id).catch(() => []);
  if (domains.length === 0) return null;

  try {
    return await withDeploymentPlatform(dep, async ({ executor, effectiveTarget }) => {
      if (effectiveTarget === "cloud") return null;
      if (!executor) {
        return "Couldn't retry routing because the deployment target has no host executor.";
      }

      const recovery = await reconcileServerEdge(executor, { onLog: () => {} });
      if (recovery.error) {
        return `Couldn't restore the edge before retrying routing: ${recovery.error}`;
      }

      const status = await checkEdge(executor);
      return status.healthy
        ? null
        : `Couldn't restore the edge before retrying routing: ${status.message}`;
    });
  } catch (err) {
    return `Couldn't restore the edge before retrying routing: ${safeErrorMessage(err)}`;
  }
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
