/**
 * GitHub webhook check_run events.
 */

import { repos } from "@repo/db";
import { triggerDeployment } from "@repo/platform/engine/modules/deployments/build.service";
import { webhookActorCtx } from "./webhook-shared";
import { resolveOrgOwner } from "@repo/platform/engine/lib/org-actor";
import type { WebhookHandlerResult } from "@repo/platform/engine/modules/webhooks/webhook.types";
import type { GitHubCheckRunPayload } from "@repo/contracts";

// ─── check_run events ────────────────────────────────────────────────────────

/** Re-run the recorded deployment (or just its service) at the same commit.
 * A signed delivery must still match its stored repository and revision: a
 * webhook secret for another repository never authorizes a cross-project run. */
export async function handleCheckRun(
  payload: GitHubCheckRunPayload,
): Promise<WebhookHandlerResult> {
  if (payload.action !== "rerequested") {
    return {
      success: true,
      event: "check_run",
      message: `check_run.${payload.action} acknowledged`,
    };
  }

  const checkRunId = payload.check_run?.id;
  if (!checkRunId) {
    return { success: true, event: "check_run", message: "Missing check_run.id" };
  }

  const check = await repos.deploymentCheck.findByCheckRunId(checkRunId);
  // Existing service checks keep their re-run action; new reports all use the
  // shared mirror. Both resolve into the same deployment admission below.
  const sd = check?.serviceDeploymentId
    ? await repos.serviceDeployment.findById(check.serviceDeploymentId)
    : !check ? await repos.serviceDeployment.findByCheckRunId(checkRunId) : undefined;
  const deploymentId = check?.deploymentId ?? sd?.deploymentId;
  if (!deploymentId) return { success: true, event: "check_run", message: "No matching deployment Check" };
  const dep = await repos.deployment.findById(deploymentId);
  if (!dep) return { success: true, event: "check_run", message: "Deployment no longer exists" };
  const origin = check?.source ?? (check
    ? (await repos.deploymentCheck.list(dep.id)).find(row => row.kind === "rollup")?.source
    : null);
  const project = await repos.project.findById(dep.projectId);
  const repoMatches = (owner: string | null, repo: string | null) =>
    owner?.toLowerCase() === payload.repository?.owner?.login?.toLowerCase() &&
    repo?.toLowerCase() === payload.repository?.name?.toLowerCase();
  if (!project || project.organizationId !== dep.organizationId || project.gitProvider !== "github" || project.deletedAt || project.deletionInProgress ||
      project.githubChecks?.enabled === false || !repoMatches(project.gitOwner, project.gitRepo) ||
      !dep.commitSha || dep.commitSha !== payload.check_run.head_sha ||
      (check && (!origin || !repoMatches(origin.owner, origin.repo))))
    return { success: true, event: "check_run", message: "Check does not match the active project source" };
  let serviceId = sd?.serviceId;
  if (check?.kind === "service" && !serviceId) {
    serviceId = (await repos.service.listByProject(project.id)).find(service =>
      service.name === check.serviceName && service.enabled)?.id;
    if (!serviceId) return { success: true, event: "check_run", message: "Service no longer exists" };
  }

  const owner = await resolveOrgOwner(project.organizationId);
  if (!owner) {
    return {
      success: true,
      event: "check_run",
      message: `No org owner for project ${project.id}`,
    };
  }
  const actorUserId = owner.userId;

  const branch = dep.branch ?? project.gitBranch ?? "main";
  // Re-running a single check rebuilds JUST that service at the same commit.
  // We pass the ORIGINAL deploy's commitShaBefore explicitly so the rollback
  // anchor stays the same as the first run (don't let it re-resolve to the
  // latest successful deploy). The rollback STRATEGY defaults via the shared
  // resolveRollbackContext helper inside triggerDeployment.
  await triggerDeployment(
    webhookActorCtx(actorUserId, project.organizationId, "webhook:github-check-rerequest"),
    {
      projectId: project.id,
      branch,
      commitSha: dep.commitSha ?? undefined,
      commitMessage: dep.commitMessage ?? undefined,
      // "check-run" (not "webhook") so it bypasses the push commit-sha dedup —
      // a deliberate re-run at the current commit.
      trigger: "check-run",
      serviceIds: serviceId ? [serviceId] : undefined,
      forceAll: !serviceId,
      commitShaBefore: dep.commitShaBefore ?? undefined,
    },
  ); // The dispatcher records a failed admission so redelivery can retry it.

  return {
    success: true,
    event: "check_run",
    message: `Re-deploying ${serviceId ? "service" : "project"} from check_run ${checkRunId}`,
  };
}
