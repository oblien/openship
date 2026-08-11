/**
 * Deployment service - deployment CRUD and runtime operations.
 *
 * Build pipeline logic lives in build.service.ts.
 * SSL operations live in ssl.service.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { repos } from "@repo/db";
import { NotFoundError, ForbiddenError } from "@repo/core";
import type { LogEntry } from "@repo/adapters";
import type { RequestContext } from "../../lib/request-context";
import { resolveDeploymentRuntime, type DeploymentMeta } from "../../lib/deployment-runtime";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import { collectDeploymentManifest, executeCleanup } from "../projects/project-cleanup.service";
import { assertGitHubRepoAccess } from "../github/github-access";
import { maskDeploymentEnv } from "../../lib/secret-env";
import { rollback, setPin, resolveRestorePlan, planNeedsRepository } from "./rollback";

/**
 * #336: present a deployment to a CLIENT — masks `meta.composeServices[].environment`.
 * This is the single boundary every client-facing return must go through; the
 * raw `getDeployment` (and repos.deployment reads) stay unmasked for the internal
 * mutating callers (delete/rollback/reject/keep) that need the real env. Prefer
 * these over calling `maskDeploymentEnv` ad-hoc at each controller return so a new
 * endpoint has one obvious thing to call instead of a per-site decision to forget.
 */
export const presentDeployment = <T extends { meta?: unknown } | null | undefined>(dep: T): T =>
  maskDeploymentEnv(dep);
export const presentDeployments = <T extends { meta?: unknown }>(deps: T[]): T[] =>
  deps.map((d) => maskDeploymentEnv(d));

/**
 * GitHub access gate for a deployment-scoped action (rollback, reject).
 * Loads the deployment's project and hard-asserts the caller may act on
 * its repo — default-deny for non-owners without a grant. No-op for
 * non-GitHub projects. Org-scope of the deployment is verified first.
 */
export async function assertGitHubAccessForDeployment(
  ctx: RequestContext,
  deploymentId: string,
  organizationId: string,
): Promise<void> {
  const dep = await getDeployment(deploymentId, organizationId);
  const project = await repos.project.findById(dep.projectId);
  if (!project) return;
  await assertGitHubRepoAccess(ctx, {
    owner: project.gitOwner,
    repo: project.gitRepo,
  });
}

async function listServiceContainerIds(deploymentId: string): Promise<string[]> {
  const rows = await repos.service.listByDeployment(deploymentId);
  return [...new Set(rows.map((row) => row.containerId).filter((id): id is string => !!id))];
}

async function listDeploymentContainerIds(dep: { id: string; containerId?: string | null }) {
  const serviceContainerIds = await listServiceContainerIds(dep.id);
  if (serviceContainerIds.length > 0) return serviceContainerIds;
  return dep.containerId ? [dep.containerId] : [];
}

export async function listDeployments(
  organizationId: string,
  opts: {
    projectId?: string;
    environment?: string;
    page?: number;
    perPage?: number;
  },
) {
  if (opts.projectId) {
    const project = await repos.project.findById(opts.projectId);
    assertResourceInOrg(project, "Project", organizationId, opts.projectId);
    const result = await repos.deployment.listByProject(opts.projectId, {
      page: opts.page,
      perPage: opts.perPage,
      environment: opts.environment,
    });
    // Mark which row is currently active so the dashboard can render the
    // "Active" chip + gate the rollback action. The schema columns
    // artifactRetainedAt + pinned flow through ...row automatically.
    const activeId = project.activeDeploymentId;
    return {
      ...result,
      rows: result.rows.map((d) => ({ ...d, isActive: d.id === activeId })),
    };
  }

  // No projectId — list scoped to active org. organizationId is required
  // on every authenticated route (the route-permission middleware
  // ensures it's set before this is reached).
  const result = await repos.deployment.listByOrganization(organizationId, {
    page: opts.page,
    perPage: opts.perPage,
  });

  const projectIds = [...new Set(result.rows.map((d) => d.projectId))];
  const projectMap = new Map<string, { name: string; activeDeploymentId: string | null }>();
  for (const pid of projectIds) {
    const p = await repos.project.findById(pid);
    if (p) projectMap.set(pid, { name: p.name, activeDeploymentId: p.activeDeploymentId });
  }

  const enriched = result.rows.map((d) => {
    const proj = projectMap.get(d.projectId);
    return {
      ...d,
      projectName: proj?.name ?? "Unknown",
      isActive: proj?.activeDeploymentId === d.id,
    };
  });

  return { ...result, rows: enriched };
}

export async function getDeployment(
  deploymentId: string,
  organizationId: string,
) {
  const dep = await repos.deployment.findById(deploymentId);
  assertResourceInOrg(dep, "Deployment", organizationId, deploymentId);

  // Cross-check the parent project belongs to the same org. This guards
  // against orphaned deployments whose project moved orgs.
  const project = await repos.project.findById(dep.projectId);
  assertResourceInOrg(project, "Deployment", organizationId, deploymentId);

  return dep;
}

/**
 * Refuse a mutating action on the self-deployed control plane's deployment. Its
 * row is an ADOPT deployment over the already-running host process (supervised
 * by the CLI, not this pipeline) — rollback/restart/delete/pin would be
 * meaningless or would detach the live app (clearing activeDeploymentId).
 * Build/redeploy is already blocked in build.service (triggerDeployment).
 */
async function assertNotControlPlaneDeployment(dep: { projectId: string }): Promise<void> {
  const project = await repos.project.findById(dep.projectId);
  if (project?.appTemplateId === "openship") {
    throw new ForbiddenError(
      "The Openship control plane manages its own runtime — this action isn't available here. Use the CLI.",
    );
  }
}

export async function deleteDeployment(
  deploymentId: string,
  organizationId: string,
) {
  const dep = await getDeployment(deploymentId, organizationId);
  await assertNotControlPlaneDeployment(dep);

  if (["queued", "building", "deploying"].includes(dep.status)) {
    throw new ForbiddenError("Cannot delete a deployment that is in progress. Cancel it first.");
  }

  const project = await repos.project.findById(dep.projectId);

  const manifest = await collectDeploymentManifest(dep, project ?? null);
  if (manifest.resources.length > 0) {
    await executeCleanup(manifest);
  }

  // Deleting the active release clears the live pointer → project reads draft.
  // We deliberately do NOT auto-point at an older successful deploy: its runtime
  // was stopped when this one went active, so claiming it "live" would be a lie
  // (a 502 masked as healthy). To bring a previous release back up, roll back to
  // it explicitly (restores its runtime). Reject uses the predecessor path for
  // that; a bare delete just detaches.
  if (project && project.activeDeploymentId === deploymentId) {
    await repos.project.setActiveDeployment(project.id, null);
  }

  await repos.deployment.deleteDeployment(deploymentId);
}

// Thin wrapper around the RollbackOrchestrator. The orchestrator owns
// the policy + the runtime primitive calls; this service just adds the
// per-org ownership check via getDeployment.

export async function rollbackDeployment(
  deploymentId: string,
  organizationId: string,
) {
  // Existence + org-scope check (throws if deployment isn't in this org).
  const dep = await getDeployment(deploymentId, organizationId);
  await assertNotControlPlaneDeployment(dep);
  await rollback(deploymentId);
  // Return the post-rollback deployment row (now with any updated container id).
  return (await repos.deployment.findById(dep.id)) ?? dep;
}

/**
 * How a rollback to this deployment WOULD run — instant from the retained
 * artifact, or a rebuild from its commit. Read-only.
 *
 * Serves the confirm dialog's copy and the controller's GitHub-access gate from
 * the same resolution the executor uses, so the three can't disagree.
 */
export async function previewRestore(deploymentId: string, organizationId: string) {
  const dep = await getDeployment(deploymentId, organizationId);
  await assertNotControlPlaneDeployment(dep);
  const { plan } = await resolveRestorePlan(deploymentId);
  return {
    mode: plan.mode,
    /** True when the restore needs the repo (clone + token + GitHub access). */
    needsRepository: planNeedsRepository(plan),
    /** Services that will rebuild because their image is gone (empty = fully instant). */
    rebuildServices: plan.mode === "redeploy-pinned" ? plan.rebuildServices : [],
    ...(plan.mode === "ineligible" ? { code: plan.code, reason: plan.message } : {}),
  };
}

export async function setDeploymentPin(
  deploymentId: string,
  organizationId: string,
  pinned: boolean,
) {
  const dep = await getDeployment(deploymentId, organizationId);
  await assertNotControlPlaneDeployment(dep);
  await setPin(deploymentId, pinned);
  return (await repos.deployment.findById(dep.id)) ?? dep;
}

export async function rejectDeployment(
  deploymentId: string,
  organizationId: string,
) {
  const dep = await getDeployment(deploymentId, organizationId);

  // Reject targets a FINISHED deploy: a fully-ready one, or a partial-failure
  // compose deploy (the case that surfaces the "N of M services failed —
  // reject?" prompt). Anything still in flight must be cancelled first.
  if (dep.status !== "ready" && dep.status !== "partial_failure") {
    throw new ForbiddenError("Can only reject a completed deployment");
  }

  const project = await repos.project.findById(dep.projectId);
  if (!project) throw new NotFoundError("Project", dep.projectId);

  const meta = (dep.meta as { previousActiveDeploymentId?: string } | null) ?? null;
  const previousDeploymentId = meta?.previousActiveDeploymentId;

  // Restore the deployment this one replaced (if any) as the active/finalized
  // one — same as before.
  if (previousDeploymentId && previousDeploymentId !== deploymentId) {
    await rollbackDeployment(previousDeploymentId, organizationId);
  }

  // Tear down THIS deployment's runtime resources (containers/routes). We
  // deliberately do NOT delete the deployment row or its build_session:
  // "reject" means "don't finalize this deploy", not "erase it". Keeping the
  // record + logs is the whole point — the failure has to stay inspectable in
  // the project's deployment history.
  const manifest = await collectDeploymentManifest(dep, project);
  if (manifest.resources.length > 0) {
    await executeCleanup(manifest);
  }

  // With no recorded predecessor there's nothing to restore, so clear the live
  // pointer (→ draft). A redeploy over an active project always records a
  // predecessor (handled above, which restores that release AND its runtime),
  // so this only fires when rejecting a first/only deploy — where draft is the
  // honest state. We don't point at an older deploy whose runtime is stopped.
  if (!previousDeploymentId && project.activeDeploymentId === deploymentId) {
    await repos.project.setActiveDeployment(project.id, null);
  }

  // Terminal "rejected" status — record and logs preserved. Also stamp the
  // compose decision so a directly-opened rejected deploy never re-reads as
  // "Action Required" (build-status derives decisionPending from meta). Mirrors
  // keepDeployment, which writes decision:"kept".
  const rejectMeta = (dep.meta as Record<string, unknown> | null) ?? {};
  const rejectedCompose = rejectMeta.composeDeployment as Record<string, unknown> | undefined;
  await repos.deployment.updateStatus(
    deploymentId,
    "rejected",
    rejectedCompose
      ? { meta: { ...rejectMeta, composeDeployment: { ...rejectedCompose, decision: "rejected" } } }
      : undefined,
  );

  return {
    success: true,
    restoredDeploymentId: previousDeploymentId ?? null,
  };
}

/**
 * Keep (confirm) a partial-failure deploy that is awaiting a decision. The
 * succeeded services are already live in-place; "keep" just clears the pending
 * marker so the deploy stops reading as "Action Required" and settles as a
 * kept partial. Idempotent — re-keeping an already-resolved deploy is a no-op.
 */
export async function keepDeployment(
  deploymentId: string,
  organizationId: string,
) {
  const dep = await getDeployment(deploymentId, organizationId);

  if (dep.status !== "partial_failure") {
    throw new ForbiddenError("Only a deployment awaiting a decision can be kept");
  }

  const meta = (dep.meta as Record<string, unknown> | null) ?? {};
  const existingCompose = (meta.composeDeployment as Record<string, unknown> | undefined) ?? {};
  if (existingCompose.decision === "pending") {
    await repos.deployment.updateStatus(deploymentId, "partial_failure", {
      meta: { ...meta, composeDeployment: { ...existingCompose, decision: "kept" } },
    });
  }

  // Normally onSuccess already advanced the pointer to this release; ensure it
  // (the kept partial is the live one now).
  const project = await repos.project.findById(dep.projectId);
  if (project && project.activeDeploymentId !== deploymentId) {
    await repos.project.setActiveDeployment(project.id, deploymentId);
  }

  return {
    success: true,
    deployment: (await repos.deployment.findById(deploymentId)) ?? dep,
  };
}

/**
 * Dismiss a port-check advisory. Appends `target` (the exposed port for a
 * single-app, or the service id for a compose service) to `meta.portCheckSkipped`
 * so the dashboard won't re-raise that advisory after a refresh. Advisory-only —
 * never changes deployment status.
 */
export async function skipPortCheck(
  deploymentId: string,
  organizationId: string,
  target: number | string,
) {
  const dep = await getDeployment(deploymentId, organizationId);
  const meta = (dep.meta as Record<string, unknown> | null) ?? {};
  const existing = Array.isArray(meta.portCheckSkipped)
    ? (meta.portCheckSkipped as (number | string)[])
    : [];
  if (!existing.includes(target)) {
    await repos.deployment.updateStatus(deploymentId, dep.status, {
      meta: { ...meta, portCheckSkipped: [...existing, target] },
    });
  }
  return { success: true };
}

/**
 * Tail the control plane's own process log (tee'd by `openship up` to
 * OPENSHIP_INSTANCE_LOG). The self-app is an adopt deployment with no container,
 * so its "runtime logs" ARE the running instance's stdout/stderr. Empty when the
 * env var is unset (e.g. foreground `up` with no tee, or non-CLI deploy).
 */
function readInstanceLog(tail?: number): LogEntry[] {
  const path = process.env.OPENSHIP_INSTANCE_LOG;
  if (!path || !existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const n = tail && tail > 0 ? tail : 500;
  return lines.slice(-n).map((message) => {
    const level: LogEntry["level"] = /error|exception|fatal/i.test(message)
      ? "error"
      : /warn/i.test(message)
        ? "warn"
        : "info";
    return { timestamp: "", message, level };
  });
}

export async function getDeploymentLogs(
  deploymentId: string,
  organizationId: string,
  tail?: number,
) {
  const dep = await getDeployment(deploymentId, organizationId);

  // Self-app adopt deployment: no container — its logs are the control plane's
  // own process output (OPENSHIP_INSTANCE_LOG), not a build session / container.
  if ((dep.meta as DeploymentMeta | null)?.adopt) {
    return readInstanceLog(tail);
  }

  // Keyed by deploymentId — findBuildSession filters by the build-session id and
  // would always miss here (returning [] then falling back to container logs).
  const buildSessions = await repos.deployment.findBuildSessionByDeploymentId(deploymentId);
  if (buildSessions?.logs) {
    return buildSessions.logs as LogEntry[];
  }

  if (dep.containerId) {
    const { runtime } = await resolveDeploymentRuntime(dep);
    return runtime.getRuntimeLogs(dep.containerId, tail);
  }

  return [];
}

export async function restartDeployment(
  deploymentId: string,
  organizationId: string,
) {
  const dep = await getDeployment(deploymentId, organizationId);
  await assertNotControlPlaneDeployment(dep);

  if (dep.status !== "ready") {
    throw new ForbiddenError("Can only restart a running deployment");
  }
  const containerIds = await listDeploymentContainerIds(dep);
  if (containerIds.length === 0) {
    throw new ForbiddenError("Deployment has no container");
  }

  const { runtime } = await resolveDeploymentRuntime(dep);
  for (const containerId of containerIds) {
    await runtime.restart(containerId);
  }

  return dep;
}

export async function getContainerInfo(
  deploymentId: string,
  organizationId: string,
) {
  const dep = await getDeployment(deploymentId, organizationId);
  if (!dep.containerId) {
    throw new ForbiddenError("Deployment has no container");
  }
  const { runtime } = await resolveDeploymentRuntime(dep);
  return runtime.getContainerInfo(dep.containerId);
}

export async function getContainerUsage(
  deploymentId: string,
  organizationId: string,
) {
  const dep = await getDeployment(deploymentId, organizationId);
  if (!dep.containerId) {
    throw new ForbiddenError("Deployment has no container");
  }
  const { runtime } = await resolveDeploymentRuntime(dep);
  return runtime.getUsage(dep.containerId);
}

export async function getBuildLogs(
  deploymentId: string,
  organizationId: string,
) {
  await getDeployment(deploymentId, organizationId);

  const buildSession = await repos.deployment.findBuildSessionByDeploymentId(deploymentId);
  if (!buildSession?.logs) {
    return [];
  }
  return buildSession.logs as LogEntry[];
}


