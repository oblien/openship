import { repos, type Project, type Deployment } from "@repo/db";
import { isServiceSuccessStatus, isServiceFailureStatus } from "@repo/core";
import { runtimeTarget } from "../../config";
import { buildBackgroundContext } from "../../lib/request-context";
import { resolveOrgOwner } from "../../lib/org-actor";
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
 * GitHub Checks API per-service hook: report a service's FINAL state.
 *
 * Completion-only, by construction. There used to be a `phase: "start"` mode
 * that opened an `in_progress` check, but nothing could call it: a targeted
 * service has no `service_deployment` row until the compose loop records its
 * outcome, so there was no id to hang the check on — and finalizeComposeDeploy
 * only emits when the deploy settled `ready`, so any start check would have sat
 * unresolved on the PR forever after a failure. Reporting once, at the end, is
 * the only shape this pipeline can honour.
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
  conclusion?: "success" | "failure" | "cancelled" | "neutral";
  output?: { title: string; summary: string };
}): Promise<void> {
  const { project, dep, serviceDeploymentId, serviceName, conclusion, output } = opts;
  if (!project.gitOwner || !project.gitRepo || !dep.commitSha) return;

  // Act as the org OWNER, not `members[0]`. A check run is Openship reporting on a
  // build it already ran — not a member action — but the GitHub authorization gate
  // resolves the actor's real role from the DB, so an arbitrary first member
  // (ordering is unspecified) made this feature work or silently vanish depending
  // on who happened to sort first and what repos they were granted.
  const actor = await resolveOrgOwner(dep.organizationId).catch(() => null);
  if (!actor?.userId) return;
  const actorCtx = buildBackgroundContext({
    userId: actor.userId,
    organizationId: dep.organizationId,
    label: "build:check-run",
  });

  const sd = await repos.serviceDeployment.findById(serviceDeploymentId).catch(() => null);
  // GitHub 422s a `completed` check run that carries no conclusion, and
  // `conclusion` is optional in this signature — so default once, for both
  // branches, instead of only defending the update path.
  const finalConclusion = conclusion ?? "neutral";
  if (sd?.checkRunId) {
    await updateCheckRun(actorCtx, project.gitOwner, project.gitRepo, sd.checkRunId, {
      status: "completed",
      conclusion: finalConclusion,
      output,
    });
    return;
  }

  // No start check ran — and for a targeted service none CAN. Its
  // `service_deployment` row is written by the compose loop at the service's
  // TERMINAL outcome, so there is no earlier id for an `in_progress` check to
  // hang on; and finalizeComposeDeploy only reaches this emit on a `ready`
  // deploy, so a start check would sit unresolved on the PR forever after a
  // failed one. Create-and-complete in ONE call instead, for EVERY conclusion:
  // gating this on `neutral` meant only SKIPPED services ever reached GitHub,
  // and a full (unscoped) deploy — which pre-creates no rows at all — posted
  // nothing whatsoever.
  const result = await createCheckRun(actorCtx, project.gitOwner, project.gitRepo, {
    name: `build:${serviceName}`,
    headSha: dep.commitSha,
    status: "completed",
    conclusion: finalConclusion,
    detailsUrl: `${runtimeTarget.dashboard.replace(/\/$/, "")}/build/${dep.id}`,
    output:
      output ??
      (finalConclusion === "neutral"
        ? { title: "Skipped — no changes", summary: "Files under this service's root were unchanged." }
        : { title: `${serviceName} ${finalConclusion}`, summary: "" }),
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

/**
 * Emit the up-front GitHub Check for every service this deploy is SKIPPING, so
 * an unchanged service reads as a deliberate `neutral` on the PR rather than as
 * a missing check.
 *
 * Only skipped services, deliberately: `preCreateServiceDeployments` inserts
 * rows for those and nothing else, because a TARGETED service has no row until
 * the compose loop records its outcome. This function used to branch on
 * `entry.targeted` to emit an `in_progress` start check, but that branch could
 * never run — a targeted entry's `id` is null here, so the guard above it always
 * skipped it. Targeted services get one create-and-complete check at finalize
 * instead (see the `phase === "complete"` tail above), which is also the only
 * shape that can't strand an `in_progress` check on a failed deploy.
 *
 * Best-effort; the check_run_id is persisted so a later patch hits the same Check.
 */
export async function emitInitialServiceChecks(
  serviceFanOut: Awaited<ReturnType<typeof preCreateServiceDeployments>>,
  project: Project,
  dep: Deployment,
): Promise<void> {
  for (const entry of serviceFanOut.values()) {
    if (!entry.id || entry.targeted) continue;
    await emitServiceCheckRun({
      project,
      dep,
      serviceDeploymentId: entry.id,
      serviceName: entry.serviceName,
      conclusion: "neutral",
      output: { title: "Skipped — no changes", summary: "Files under this service's root were unchanged." },
    }).catch(() => {});
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
