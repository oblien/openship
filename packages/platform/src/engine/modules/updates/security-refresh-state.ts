import type { ProjectSecurityResult } from "@repo/contracts";
import { repos } from "@repo/db";

/** Read persisted work only; opening the banner never executes a runtime probe. */
export async function annotateSecurityRefreshState(result: ProjectSecurityResult) {
  if (!result.findings.length) return;
  const attempts = await repos.securityAdvisory.attemptsForProject(result.projectId);
  for (const finding of result.findings) {
    const attempt = attempts.find(
      (a) => a.advisoryId === finding.id && a.serviceId === finding.serviceId,
    );
    if (!attempt) continue;
    if (attempt.status === "failed") {
      // A later successful deployment invalidates an old failure receipt.
      if (attempt.deploymentId && attempt.deploymentId !== result.deploymentId) continue;
      finding.refresh = {
        status: "failed",
        deploymentId: attempt.deploymentId,
        error: attempt.error,
      };
      continue;
    }
    if (!["pending", "queued", "awaiting_actions"].includes(attempt.status)) continue;
    const deployment = attempt.deploymentId
      ? await repos.deployment.findById(attempt.deploymentId)
      : null;
    if (deployment && deployment.projectId !== result.projectId) continue;
    // A completed update for an older release must not hide findings on a newer one.
    if (deployment?.status === "ready" && deployment.id !== result.deploymentId) continue;
    const stillAffected =
      deployment?.status === "ready" &&
      deployment.id === result.deploymentId &&
      !!result.checkedAt &&
      !result.unknownServices.includes(finding.serviceId);
    const abandoned =
      !deployment &&
      Date.now() - attempt.createdAt.getTime() >
        (attempt.actionRequestId ? 86_400_000 : 15 * 60_000);
    const failed =
      stillAffected ||
      abandoned ||
      (deployment &&
        [
          "failed",
          "cancelled",
          "partial_failure",
          "rejected",
          "action_required",
          "no_changes",
        ].includes(deployment.status));
    finding.refresh = {
      status: failed
        ? "failed"
        : attempt.status === "awaiting_actions" && !deployment
          ? "awaiting_actions"
          : "running",
      deploymentId: attempt.deploymentId,
      error: stillAffected
        ? "The deployment completed, but the running runtime is still affected. Choose a patched image version or update the Dockerfile; refreshing the same version is not a fix."
        : failed
          ? "The security update did not complete. Open its deployment for details; the advisory is still active."
          : null,
    };
    if (!failed) finding.canRefresh = false;
  }
}
