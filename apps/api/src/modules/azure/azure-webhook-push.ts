/**
 * Azure DevOps git.push → branch-matched redeploy.
 *
 * Hardened dispatch: EVERY ref update in the push is considered (a multi-branch
 * push deploys each matching branch, not just the first), deploys run
 * concurrently and independently (one failure never blocks the others), and
 * branch matching is case-insensitive (Azure DevOps branch names are).
 */

import { parseGitRepoUrl } from "@repo/core";
import { repos } from "@repo/db";
import { triggerDeployment } from "@repo/platform/engine/modules/deployments/build.service";
import { resolveOrgOwner } from "@repo/platform/engine/lib/org-actor";
import { webhookActorCtx } from "../github/webhook-shared";
import type { WebhookHandlerResult } from "@repo/platform/engine/modules/webhooks/webhook.types";

interface AzurePushPayload {
  eventType?: string;
  resource?: {
    refUpdates?: Array<{ name?: string; newObjectId?: string }>;
    repository?: {
      name?: string;
      remoteUrl?: string;
      project?: { name?: string };
    };
    commits?: Array<{ comment?: string }>;
  };
}

export async function handleAzurePush(payload: unknown): Promise<WebhookHandlerResult> {
  const body = payload as AzurePushPayload;
  if (body.eventType && body.eventType !== "git.push") {
    return { success: true, event: body.eventType, message: "Event not handled" };
  }

  const remoteUrl = body.resource?.repository?.remoteUrl;
  const parsed = parseGitRepoUrl(remoteUrl ?? "");
  const repo = body.resource?.repository?.name || parsed?.repo;
  const projectName = body.resource?.repository?.project?.name || parsed?.project;
  const owner = parsed?.owner;
  if (!owner || !projectName || !repo) {
    return { success: false, event: "git.push", error: "Missing repository info in payload" };
  }

  const refUpdates = (body.resource?.refUpdates ?? []).filter((r) =>
    r.name?.startsWith("refs/heads/"),
  );
  if (refUpdates.length === 0) {
    return {
      success: true,
      event: "git.push",
      message: "Ignoring push: no branch ref updates",
    };
  }

  const projects = await repos.project.findByAzureGitRepo(owner, projectName, repo);
  const autoDeployProjects = projects.filter((p) => p.autoDeploy);

  // (project, branch) deploy jobs, deduplicated — a single push can touch the
  // same branch once per ref update, and two projects may share a repo+branch.
  const jobs: Array<{ projectId: string; organizationId: string; branch: string; sha?: string }> = [];
  const seen = new Set<string>();
  for (const p of autoDeployProjects) {
    const tracked = (p.gitBranch || "main").replace(/^refs\/heads\//, "").toLowerCase();
    for (const ref of refUpdates) {
      const branch = ref.name!.replace("refs/heads/", "");
      if (tracked !== branch.toLowerCase()) continue;
      const key = `${p.id}:${branch}`;
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push({
        projectId: p.id,
        organizationId: p.organizationId,
        branch,
        sha: ref.newObjectId,
      });
    }
  }

  if (jobs.length === 0) {
    const branches = refUpdates.map((r) => r.name!.replace("refs/heads/", "")).join(", ");
    return {
      success: true,
      event: "git.push",
      message: `No auto-deploy project for ${owner}/${projectName}/${repo}#${branches}`,
    };
  }

  const commitMessage = body.resource?.commits?.[0]?.comment;
  const results = await Promise.allSettled(
    jobs.map(async (job) => {
      const orgOwner = await resolveOrgOwner(job.organizationId);
      if (!orgOwner) throw new Error(`No owner for organization ${job.organizationId}`);
      await triggerDeployment(
        webhookActorCtx(orgOwner.userId, job.organizationId, "webhook:azure-push"),
        {
          projectId: job.projectId,
          branch: job.branch,
          commitSha: job.sha,
          commitMessage,
          trigger: "webhook",
        },
      );
      return job.projectId;
    }),
  );

  const deployed = results.filter((r) => r.status === "fulfilled").length;
  const failures = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  for (const f of failures) {
    console.error("[azure-push] deploy trigger failed:", f.reason);
  }

  return {
    success: failures.length === 0,
    event: "git.push",
    message:
      failures.length === 0
        ? `Triggered ${deployed} deployment(s)`
        : `Triggered ${deployed} deployment(s); ${failures.length} failed`,
  };
}
