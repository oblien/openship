/** Plain pushes use the same leased admission controller as required-check deployments. */
import { AppError, generateId, isFullCommitSha, safeErrorMessage } from "@repo/core";
import { repos, type Project } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import type { DeploymentTriggerInput } from "../deployments/build.service";
import { captureExecutionAuthority } from "../../lib/execution-authority";
import { notification } from "../../lib/notification-dispatcher";
import { nativeJobsEnabled } from "../../native/execution-policy";
import { repositoryHead } from "./repository-head";
import { automaticDeploymentIntent } from "../deployments/automatic-deployment-intent";

export function notifyAutoDeployFailed(project: Project, err: unknown): void {
  notification.emit({
    organizationId: project.organizationId,
    eventType: "deployment.failed",
    resourceType: "project",
    resourceId: project.id,
    payload: { projectName: project.name, trigger: "webhook", reason: safeErrorMessage(err) },
  });
}

export async function queueBlockedPush(
  ctx: ExecutionContext,
  project: Project,
  input: DeploymentTriggerInput,
  expectedDeploymentId: string | null,
  receivedAt = new Date(),
) {
  if (!nativeJobsEnabled() || !project.autoDeploy) return undefined;
  const branch = input.branch || project.gitBranch;
  const revision = input.commitSha;
  if (!branch || !project.gitOwner || !project.gitRepo || !revision || !isFullCommitSha(revision))
    throw new AppError(
      "An automatic deployment needs an exact repository commit and branch.",
      409,
      "AUTODEPLOY_COMMIT_REQUIRED",
    );
  const head = await repositoryHead(ctx, project, branch);
  return repos.actions.queueActionDeployment(
    {
      id: generateId("adep"),
      organizationId: project.organizationId,
      projectId: project.id,
      revision,
      ref: `refs/heads/${branch}`,
      requirements: {},
      authority: await captureExecutionAuthority(ctx),
      status: head === revision ? "waiting" : "superseded",
      error: head === revision ? null : "This push is older than the current repository branch.",
      createdAt: receivedAt,
      intent: {
        ...automaticDeploymentIntent(input),
        kind: "push",
        repository: `${project.gitOwner}/${project.gitRepo}`.toLowerCase(),
      },
    },
    expectedDeploymentId,
  );
}
