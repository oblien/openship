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

/**
 * Handle a GitHub `check_run` event.
 *
 * The only action we actively service is `rerequested` — when a user
 * hits "Re-run" on a service-level check in the GitHub PR UI we look
 * up the originating service_deployment row, recover its
 * (project, branch, commit, service) tuple, and trigger a fresh deploy
 * for that one service at the same commit_sha (git-strategy rollback
 * style — rebuild from source).
 *
 * `requested_action` (custom action buttons) is out of scope until we
 * register any. Everything else is acked.
 */
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

  const sd = await repos.serviceDeployment.findByCheckRunId(checkRunId).catch(() => null);
  if (!sd) {
    return {
      success: true,
      event: "check_run",
      message: `No service_deployment found for check_run ${checkRunId}`,
    };
  }

  const dep = await repos.deployment.findById(sd.deploymentId).catch(() => null);
  if (!dep) {
    return {
      success: true,
      event: "check_run",
      message: `No deployment found for service_deployment ${sd.id}`,
    };
  }

  const project = await repos.project.findById(dep.projectId).catch(() => null);
  if (!project) {
    return {
      success: true,
      event: "check_run",
      message: `No project found for deployment ${dep.id}`,
    };
  }

  const owner = await resolveOrgOwner(project.organizationId).catch(() => null);
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
      serviceIds: [sd.serviceId],
      forceAll: false,
      commitShaBefore: dep.commitShaBefore ?? undefined,
    },
  ).catch((err) => {
    console.error(
      `[GitHub Webhook] check_run rerequested for sd=${sd.id} failed:`,
      err,
    );
  });

  return {
    success: true,
    event: "check_run",
    message: `Re-deploying service ${sd.serviceName} from check_run ${checkRunId}`,
  };
}
