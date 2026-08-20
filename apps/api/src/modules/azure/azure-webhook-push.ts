/**
 * Azure DevOps git.push → branch-matched redeploy. Slimmer than GitHub's
 * changed-file router: v1 always deploys the matching auto-deploy project.
 */

import { parseGitRepoUrl } from "@repo/core";
import { repos } from "@repo/db";
import { triggerDeployment } from "../deployments/build.service";
import { resolveOrgOwner } from "../../lib/org-actor";
import { webhookActorCtx } from "../github/webhook-shared";
import type { WebhookHandlerResult } from "../webhooks/webhook.types";

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

  const ref = body.resource?.refUpdates?.[0]?.name;
  if (!ref?.startsWith("refs/heads/")) {
    return { success: true, event: "git.push", message: `Ignoring non-branch ref: ${ref ?? "unknown"}` };
  }
  const branch = ref.replace("refs/heads/", "");
  const commitSha = body.resource?.refUpdates?.[0]?.newObjectId;
  const commitMessage = body.resource?.commits?.[0]?.comment;

  const projects = await repos.project.findByAzureGitRepo(owner, projectName, repo);
  const targets = projects.filter((p) => {
    if (!p.autoDeploy) return false;
    const tracked = (p.gitBranch || "main").replace(/^refs\/heads\//, "");
    return tracked === branch;
  });

  if (targets.length === 0) {
    return {
      success: true,
      event: "git.push",
      message: `No auto-deploy project for ${owner}/${projectName}/${repo}#${branch}`,
    };
  }

  let deployed = 0;
  for (const p of targets) {
    const orgOwner = await resolveOrgOwner(p.organizationId).catch(() => null);
    if (!orgOwner) continue;
    await triggerDeployment(
      webhookActorCtx(orgOwner.userId, p.organizationId, "webhook:azure-push"),
      {
        projectId: p.id,
        branch,
        commitSha,
        commitMessage,
        trigger: "webhook",
      },
    );
    deployed += 1;
  }

  return { success: true, event: "git.push", message: `Triggered ${deployed} deployment(s)` };
}
