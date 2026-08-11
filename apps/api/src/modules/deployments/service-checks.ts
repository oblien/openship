import { repos, type Project, type Deployment } from "@repo/db";
import { isServiceSuccessStatus, isServiceFailureStatus } from "@repo/core";
import { runtimeTarget } from "../../config";
import { buildBackgroundContext } from "../../lib/request-context";
import { createCheckRun, updateCheckRun } from "../github/github.service";

// Per-service GitHub-Checks + service_deployment fan-out for a multi-service
// deploy. Extracted from build-pipeline; all best-effort (never blocks a deploy).
/**
 * Pre-create `service_deployment` rows for SKIPPED services.
 *
 * For services in `targetServiceIds`, the compose pipeline creates
 * its own per-service rows during deploy (status patches reflect
 * build/deploy progress). For services NOT in the target list — i.e.
 * intentionally unchanged — the compose pipeline never runs, so this
 * helper inserts the `skipped` row up front. That keeps the fan-out
 * record on the deployment complete from the moment building starts.
 *
 * When `forceAll=true` or no target list is given, every enabled
 * service is considered targeted; we return without inserting.
 *
 * Returns ALL services (targeted + skipped) keyed by service id so
 * the caller can drive Checks API events.
 */
export async function preCreateServiceDeployments(
  deploymentId: string,
  projectId: string,
  opts: {
    targetServiceIds?: string[];
    forceAll: boolean;
  },
): Promise<Map<string, { id: string | null; serviceId: string; serviceName: string; targeted: boolean }>> {
  const services = await repos.service.listByProject(projectId).catch(() => []);
  const enabled = services.filter((s) => s.enabled);
  const map = new Map<string, { id: string | null; serviceId: string; serviceName: string; targeted: boolean }>();
  if (enabled.length === 0) return map;

  const targetSet = opts.targetServiceIds && opts.targetServiceIds.length > 0
    ? new Set(opts.targetServiceIds)
    : null;

  // Compute (targeted? per service) up front so the caller can drive
  // per-service Checks events even before the compose pipeline runs.
  for (const svc of enabled) {
    const targeted = opts.forceAll || !targetSet || targetSet.has(svc.id);
    map.set(svc.id, {
      id: null,
      serviceId: svc.id,
      serviceName: svc.name,
      targeted,
    });
  }

  // Only insert SKIPPED rows here — targeted rows are created by the
  // downstream compose deploy path, which still owns its own writes.
  const skippedRows = enabled
    .filter((svc) => {
      const entry = map.get(svc.id);
      return entry ? !entry.targeted : false;
    })
    .map((svc) => ({
      deploymentId,
      serviceId: svc.id,
      serviceName: svc.name,
      status: "skipped" as const,
      reason: "unchanged",
      reasonSkipped: "unchanged",
    }));

  if (skippedRows.length > 0) {
    const inserted = await repos.serviceDeployment.bulkCreate(skippedRows);
    for (const row of inserted) {
      const existing = map.get(row.serviceId);
      if (existing) existing.id = row.id;
    }
  }

  return map;
}

/**
 * GitHub Checks API per-service hook.
 *
 * Best-effort: any failure is logged but never blocks the deploy. We
 * skip entirely when the project isn't backed by GitHub or when there
 * is no `commit_sha` (which would make `head_sha` invalid).
 */
export async function emitServiceCheckRun(opts: {
  project: Project;
  dep: Deployment;
  serviceDeploymentId: string;
  serviceName: string;
  phase: "start" | "complete";
  conclusion?: "success" | "failure" | "cancelled" | "neutral";
  output?: { title: string; summary: string };
}): Promise<void> {
  const { project, dep, serviceDeploymentId, serviceName, phase, conclusion, output } = opts;
  if (!project.gitOwner || !project.gitRepo || !dep.commitSha) return;

  const orgMembers = await repos.member
    .listByOrganization(dep.organizationId)
    .catch(() => [] as Array<{ userId: string }>);
  const actorUserId = orgMembers[0]?.userId;
  if (!actorUserId) return;
  const actorCtx = buildBackgroundContext({
    userId: actorUserId,
    organizationId: dep.organizationId,
    label: "build:check-run",
  });

  if (phase === "start") {
    const result = await createCheckRun(actorCtx, project.gitOwner, project.gitRepo, {
      name: `build:${serviceName}`,
      headSha: dep.commitSha,
      status: "in_progress",
      detailsUrl: `${runtimeTarget.dashboard.replace(/\/$/, "")}/build/${dep.id}`,
    });
    if (result?.id) {
      await repos.serviceDeployment
        .update(serviceDeploymentId, {
          checkRunId: result.id,
          checkRunUrl: result.htmlUrl,
        })
        .catch(() => {});
    }
    return;
  }

  // phase === "complete"
  const sd = await repos.serviceDeployment.findById(serviceDeploymentId).catch(() => null);
  if (sd?.checkRunId) {
    await updateCheckRun(actorCtx, project.gitOwner, project.gitRepo, sd.checkRunId, {
      status: "completed",
      conclusion: conclusion ?? "neutral",
      output,
    });
  } else if (conclusion === "neutral") {
    // Skipped services were never started — create-and-complete in one
    // call so they still show up as a `neutral` check on the PR.
    const result = await createCheckRun(actorCtx, project.gitOwner, project.gitRepo, {
      name: `build:${serviceName}`,
      headSha: dep.commitSha,
      status: "completed",
      conclusion,
      detailsUrl: `${runtimeTarget.dashboard.replace(/\/$/, "")}/build/${dep.id}`,
      output: output ?? { title: "Skipped — no changes", summary: "Files under this service's root were unchanged." },
    });
    if (result?.id) {
      await repos.serviceDeployment
        .update(serviceDeploymentId, {
          checkRunId: result.id,
          checkRunUrl: result.htmlUrl,
        })
        .catch(() => {});
    }
  }
}

/**
 * Emit the initial per-service GitHub Checks for a fanned-out deploy:
 * targeted services get an `in_progress` "start" check, non-targeted ones
 * a neutral "skipped" check — so the PR check list is complete the moment
 * the deploy starts. Best-effort; the returned check_run_id is persisted
 * so the later `complete` emit patches the same Check.
 */
export async function emitInitialServiceChecks(
  serviceFanOut: Awaited<ReturnType<typeof preCreateServiceDeployments>>,
  project: Project,
  dep: Deployment,
): Promise<void> {
  for (const entry of serviceFanOut.values()) {
    if (!entry.id) continue;
    if (entry.targeted) {
      await emitServiceCheckRun({
        project,
        dep,
        serviceDeploymentId: entry.id,
        serviceName: entry.serviceName,
        phase: "start",
      }).catch(() => {});
    } else {
      await emitServiceCheckRun({
        project,
        dep,
        serviceDeploymentId: entry.id,
        serviceName: entry.serviceName,
        phase: "complete",
        conclusion: "neutral",
        output: { title: "Skipped — no changes", summary: "Files under this service's root were unchanged." },
      }).catch(() => {});
    }
  }
}

/**
 * Roll up per-service results into the project-level deployment status.
 *
 *   - all `success` (or `skipped`)          → `ready`
 *   - mix of `success` and `failure`        → `partial_failure`
 *   - all `failure`                         → `failed`
 *
 * `skipped` rows are not counted as failures — they're intentional.
 *
 * Classification of the per-service status vocabulary lives in @repo/core
 * (service-status) so the rollup, the container-status endpoint, and the
 * dashboard badges share ONE definition of success/failure and can't drift.
 */
export function rollupDeploymentStatus(
  perService: Array<{ status: string }>,
): "ready" | "partial_failure" | "failed" {
  const real = perService.filter((s) => s.status !== "skipped");
  if (real.length === 0) return "ready";
  const successes = real.filter((s) => isServiceSuccessStatus(s.status)).length;
  const failures = real.filter((s) => isServiceFailureStatus(s.status)).length;
  if (failures === 0) return "ready";
  if (successes === 0) return "failed";
  return "partial_failure";
}
