/** Deploys GitHub pushes that arrived while their project was still deploying.
 * The webhook records such a push as a `queued` delivery instead of dropping it. */
import { AppError, safeErrorMessage } from "@repo/core";
import { diagnostics } from "@repo/core/diagnostics";
import { repos, type Project, type WebhookDelivery } from "@repo/db";
import { buildBackgroundContext } from "../../lib/background-context";
import { notification } from "../../lib/notification-dispatcher";
import { resolveOrgOwner } from "../../lib/org-actor";
import { checkNoActiveBuild, triggerDeployment } from "../deployments/build.service";
import { isTransientGitHubFailure } from "./github.error";

export type QueuedPush = {
  repo: string;
  branch: string;
  commit?: string;
  commitMessage?: string;
  forceAll: boolean;
};

/** Surface a webhook auto-deploy that failed before a deployment row existed, so the
 *  pipeline's own deployment.failed never fired. Org-scoped and fire-and-forget, so it
 *  reaches members and channels even when there's no owner. */
export function notifyAutoDeployFailed(project: Project, err: unknown): void {
  notification.emit({
    organizationId: project.organizationId,
    eventType: "deployment.failed",
    resourceType: "project",
    resourceId: project.id,
    payload: { projectName: project.name, trigger: "webhook", reason: safeErrorMessage(err) },
  });
}

/** Record a push that found its project deploying. Unlike the feed rows, this write
 *  throws, because the row is the only copy of the push. */
export async function queuePush(project: Project, push: QueuedPush) {
  await repos.webhookDelivery.record({
    organizationId: project.organizationId,
    projectId: project.id,
    source: "github",
    event: "push",
    authResult: "ok",
    outcome: "queued",
    summary: push,
  });
}

/** Each idle project deploys its newest queued commit once, covering every older queued push. */
export async function deployQueuedPushes() {
  const byProject = new Map<string, WebhookDelivery[]>();
  for (const row of (await repos.webhookDelivery.listQueuedPushes()).rows)
    byProject.set(row.projectId!, [...(byProject.get(row.projectId!) ?? []), row]);
  let failed = 0;
  await Promise.all(
    [...byProject].map(([projectId, rows]) =>
      deployQueuedPush(projectId, rows).catch((error) => {
        failed++;
        diagnostics.warn("github/queued-pushes", "Queued push will be retried", error, {
          projectId,
        });
      }),
    ),
  );
  return { queued: byProject.size, failed };
}

async function deployQueuedPush(projectId: string, rows: WebhookDelivery[]) {
  // Rows are newest first, and the newest commit contains the older ones.
  const [newest] = rows;
  const push = newest.summary as QueuedPush;
  const settle = (outcome: string, actionRef?: string, error?: string) =>
    Promise.all(
      rows.map((row) => repos.webhookDelivery.markProcessed(row.id, { outcome, actionRef, error })),
    );
  const project = await repos.project.findById(projectId);
  if (
    !project?.autoDeploy ||
    project.disabledAt ||
    project.deletionInProgress ||
    (project.gitBranch?.trim() || push.branch) !== push.branch ||
    `${project.gitOwner}/${project.gitRepo}`.toLowerCase() !== push.repo.toLowerCase()
  )
    return settle("skipped");
  try {
    await checkNoActiveBuild(projectId);
    // A newer push, a manual deployment or a rollback replaces the queued push.
    const { rows: history } = await repos.deployment.listByProject(projectId);
    const replaced = history.find(
      (dep) =>
        dep.createdAt > newest.receivedAt &&
        ["webhook", "manual", "rollback"].includes(dep.trigger),
    );
    if (replaced) return await settle("skipped", replaced.id);
    const owner = await resolveOrgOwner(project.organizationId);
    if (!owner)
      throw new AppError("No organization owner is available to deploy the queued push.", 409);
    const ctx = buildBackgroundContext({
      userId: owner.userId,
      organizationId: project.organizationId,
      label: "webhook:queued-push",
    });
    // Smart routing compares the live deployment with the newest commit, so the
    // services changed by every collapsed push are rebuilt.
    const triggered = await triggerDeployment(ctx, {
      projectId,
      branch: push.branch,
      commitSha: push.commit,
      commitMessage: push.commitMessage,
      trigger: "webhook",
      forceAll: rows.some((row) => (row.summary as QueuedPush).forceAll),
      smartRoute: true,
    });
    await settle(triggered.skipped ? "skipped" : "dispatched", triggered.deployment?.id);
  } catch (error) {
    // The running deployment's completion is the next chance.
    if (error instanceof AppError && error.code === "DEPLOYMENT_IN_PROGRESS") return;
    // Unexpected and transient errors retry on the next sweep.
    if (!(error instanceof AppError) || isTransientGitHubFailure(error)) throw error;
    notifyAutoDeployFailed(project, error);
    await settle("failed", undefined, safeErrorMessage(error));
  }
}
