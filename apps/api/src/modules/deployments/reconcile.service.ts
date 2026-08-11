/**
 * Deployment reconciliation.
 *
 * A deployment is `reconciling` when the connection to its host dropped after
 * container(s) started, so its true outcome is unknown. This reads the ACTUAL
 * remote state — per service and per app — and settles the deployment:
 *
 *   - all containers running        → ready   (+ advance active pointer)
 *   - some running                  → partial_failure (+ advance)
 *   - none running                  → failed  (never advance — forward-only)
 *   - a container is GONE (404)      → flagged `missing` (drift) and counted
 *                                      as down for the verdict
 *   - host still unreachable         → left `reconciling`, retried next tick
 *   - runtime can't inspect (bare)   → left `reconciling` (resolved via
 *                                      supersession when a redeploy lands)
 *
 * Works for server-backed (docker) AND cloud deployments: cloud drift shows up
 * as a `missing` from `getContainerInfo` when the workspace was deleted on
 * Openship Cloud. It NEVER destroys anything (that's the whole point — the
 * containers may be healthy) and NEVER advances the project pointer on failure.
 */

import { repos, type Deployment } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import { resolveDeploymentRuntime } from "../../lib/deployment-runtime";
import { createReachabilityProbe } from "../../lib/server-reachability";
import { isConnectionLoss } from "../../lib/remote-state";

export type ReconcileOutcome =
  | "finalized" // resolved to ready / partial_failure / failed
  | "unreachable" // couldn't reach the host — left reconciling, retry later
  | "unsupported" // runtime can't be inspected (bare) — left reconciling
  | "skipped"; // not a reconciling deployment

export interface DeploymentDrift {
  missingContainers: string[];
  detectedAt: string;
  serverId: string | null;
}

/** Whether the project's live release is NEWER than `dep` — if so, a reconcile
 *  to success must NOT steal the pointer back (forward-only). */
async function isSuperseded(activeDeploymentId: string | null, dep: Deployment): Promise<boolean> {
  if (!activeDeploymentId || activeDeploymentId === dep.id) return false;
  const active = await repos.deployment.findById(activeDeploymentId).catch(() => undefined);
  if (!active) return false;
  return active.createdAt.getTime() >= dep.createdAt.getTime();
}

export async function reconcileDeployment(deploymentId: string): Promise<ReconcileOutcome> {
  const dep = await repos.deployment.findById(deploymentId);
  if (!dep || dep.status !== "reconciling") return "skipped";

  const meta = (dep.meta ?? {}) as Record<string, unknown> & {
    serverId?: string;
    deployTarget?: string;
  };
  const serverId = meta.serverId;
  const isCloud = meta.deployTarget === "cloud";

  // Server-backed: fast-fail if the host still isn't answering — leave the
  // deployment `reconciling` for the next tick rather than guessing.
  if (!isCloud && serverId) {
    const probe = createReachabilityProbe();
    if (!(await probe.isReachable(serverId))) return "unreachable";
  }

  let runtime;
  try {
    ({ runtime } = await resolveDeploymentRuntime(dep));
  } catch (err) {
    if (isConnectionLoss(err)) return "unreachable";
    // Server removed / unresolvable — can't verify. Leave reconciling (a
    // redeploy supersedes it; task B17) rather than guessing failed.
    console.warn(`[reconcile] ${dep.id}: cannot resolve runtime — ${safeErrorMessage(err)}`);
    return "unreachable";
  }

  // Bare runtime can't inspect containers by id — leave reconciling; the
  // one-active-per-project index excludes reconciling so a redeploy can land.
  if (!runtime.supports("containerInfo")) return "unsupported";

  // Inspect targets: every service container, or the single-app container.
  const serviceDeps = await repos.serviceDeployment.listByDeployment(dep.id);
  const targets = serviceDeps
    .filter((sd) => sd.containerId)
    .map((sd) => ({
      rowId: sd.id,
      containerId: sd.containerId as string,
      name: sd.serviceName ?? undefined,
      isService: true,
    }));
  if (targets.length === 0 && dep.containerId && dep.containerId !== "compose") {
    targets.push({ rowId: dep.id, containerId: dep.containerId, name: undefined, isService: false });
  }

  // Services that terminally FAILED with no container (e.g. build error) count
  // toward the verdict as "down" — otherwise a mix of build-failure +
  // connection-loss could wrongly resolve to "ready" and mask the failure.
  // `skipped` (unchanged, carried-forward) rows are NOT failures and are excluded.
  const failedNoContainer = serviceDeps.filter((sd) => {
    // `failed` vs `failure` — the compose catch writes "failed" while the repo
    // union says "failure"; match both. Cast because "failed" isn't in the union.
    const s = sd.status as string;
    return !sd.containerId && (s === "failure" || s === "failed" || s === "cancelled");
  }).length;

  if (targets.length === 0) {
    await repos.deployment.updateStatus(dep.id, "failed", {
      errorMessage: "Reconcile found no containers to verify.",
    });
    return "finalized";
  }

  const missing: string[] = [];
  let up = 0;
  for (const t of targets) {
    let state: "running" | "missing" | "down";
    try {
      const info = await runtime.getContainerInfo(t.containerId);
      state = info.status === "running" ? "running" : info.status === "missing" ? "missing" : "down";
    } catch (err) {
      // A connection error mid-inspect means the host went away again — abort
      // the whole reconcile and retry later rather than recording half-truths.
      if (isConnectionLoss(err)) return "unreachable";
      state = "down";
    }

    if (state === "running") up++;
    if (state === "missing") missing.push(t.name ?? t.containerId.slice(0, 12));

    if (t.isService) {
      await repos.serviceDeployment
        .update(t.rowId, {
          status: state === "running" ? "success" : state === "missing" ? "missing" : "failure",
        })
        .catch(() => {});
    }
  }

  const total = targets.length + failedNoContainer;
  const verdict = up === total ? "ready" : up > 0 ? "partial_failure" : "failed";

  const nextMeta: Record<string, unknown> = { ...meta };
  if (missing.length > 0) {
    nextMeta.drift = {
      missingContainers: missing,
      detectedAt: new Date().toISOString(),
      serverId: serverId ?? null,
    } satisfies DeploymentDrift;
  } else {
    delete nextMeta.drift;
  }

  if (verdict === "failed") {
    // Forward-only: a failed reconcile NEVER advances the project pointer.
    await repos.deployment.updateStatus(dep.id, "failed", { meta: nextMeta });
    return "finalized";
  }

  if (verdict === "partial_failure") {
    // Hold for an explicit keep/reject decision — same as the normal compose
    // finalize path — so a connection-loss deploy that reconciles to a partial
    // failure can't silently read as a clean "Deployed".
    const existingCompose =
      (nextMeta.composeDeployment as Record<string, unknown> | undefined) ?? {};
    nextMeta.composeDeployment = { ...existingCompose, decision: "pending" };
  }

  await repos.deployment.updateStatus(dep.id, verdict, { errorMessage: null, meta: nextMeta });

  const project = await repos.project.findById(dep.projectId);
  if (project && !(await isSuperseded(project.activeDeploymentId, dep))) {
    await repos.project.setActiveDeployment(project.id, dep.id);
  }
  return "finalized";
}

// De-dupe concurrent on-demand reconciles (e.g. rapid deployment-detail loads)
// so a burst of page views doesn't stampede the runtime.
const inFlight = new Set<string>();

/** Fire-and-forget reconcile for a `reconciling` deployment (on-load trigger).
 *  Safe to call unconditionally — no-ops if one is already running for this id. */
export function triggerReconcile(deploymentId: string): void {
  if (inFlight.has(deploymentId)) return;
  inFlight.add(deploymentId);
  void reconcileDeployment(deploymentId)
    .catch((err) => console.error(`[reconcile] on-demand ${deploymentId} failed:`, safeErrorMessage(err)))
    .finally(() => inFlight.delete(deploymentId));
}
