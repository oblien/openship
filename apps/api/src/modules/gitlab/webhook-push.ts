/**
 * GitLab webhook push events — branch-matched redeployment.
 */

import { repos, type Project } from "@repo/db";
import { triggerDeployment } from "../deployments/build.service";
import { safeErrorMessage } from "@repo/core";
import { webhookActorCtx } from "../github/webhook-shared";
import { resolveOrgOwner } from "../../lib/org-actor";
import { notification } from "../../lib/notification-dispatcher";
import type { WebhookHandlerResult } from "../webhooks/webhook.types";
import type { GitLabPushPayload } from "./gitlab.types";
import { splitPathWithNamespace } from "./gitlab.service";

function notifyAutoDeployFailed(project: Project, err: unknown): void {
  notification.emit({
    organizationId: project.organizationId,
    eventType: "deployment.failed",
    resourceType: "project",
    resourceId: project.id,
    payload: {
      projectName: project.name,
      trigger: "webhook",
      reason: safeErrorMessage(err),
    },
  });
}

function projectWebhookBranch(p: Project, defaultBranch: string | null | undefined): string {
  const configured = p.gitBranch?.trim();
  if (configured) return configured;
  return defaultBranch?.trim() || "main";
}

interface BranchDeploymentTrigger {
  event: string;
  owner: string;
  repo: string;
  branch: string;
  commitSha: string | null;
  commitMessage: string | null;
  defaultBranch?: string | null;
}

async function deployProjectFromPush(
  p: Project,
  input: BranchDeploymentTrigger,
): Promise<unknown> {
  const owner = await resolveOrgOwner(p.organizationId).catch(() => null);
  const actorUserId = owner?.userId;
  if (!actorUserId) {
    throw new Error(`No org owner for project ${p.id}`);
  }

  return triggerDeployment(
    webhookActorCtx(actorUserId, p.organizationId, "webhook:gitlab-push"),
    {
      projectId: p.id,
      branch: input.branch,
      commitSha: input.commitSha ?? undefined,
      commitMessage: input.commitMessage ?? undefined,
      trigger: "webhook",
    },
  );
}

async function triggerBranchDeployments(
  input: BranchDeploymentTrigger,
): Promise<WebhookHandlerResult> {
  const projects = await repos.project.findByGitRepo(input.owner, input.repo, "gitlab");
  const defaultBranch = input.defaultBranch ?? null;
  const autoDeployProjects = projects.filter(
    (p) => p.autoDeploy && projectWebhookBranch(p, defaultBranch) === input.branch,
  );

  if (autoDeployProjects.length === 0) {
    console.log(
      `[GitLab Webhook] ${input.event} for ${input.owner}/${input.repo}#${input.branch} - no matching auto-deploy project`,
    );
    return {
      success: true,
      event: input.event,
      message: "No auto-deploy projects matched",
    };
  }

  const results = await Promise.allSettled(
    autoDeployProjects.map((p) =>
      deployProjectFromPush(p, input).catch((err) => {
        notifyAutoDeployFailed(p, err);
        throw err;
      }),
    ),
  );

  let succeeded = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === "fulfilled") succeeded++;
    else failed++;
  }

  if (failed > 0) {
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => String(r.reason));
    console.error(
      `[GitLab Webhook] ${input.event} deploy failures for ${input.owner}/${input.repo}#${input.branch}:`,
      errors,
    );
  }

  return {
    success: true,
    event: input.event,
    message:
      `Triggered ${succeeded} deployment(s) for ${input.owner}/${input.repo}#${input.branch}` +
      `${failed ? `, ${failed} failed` : ""}`,
  };
}

export async function handlePush(
  payload: GitLabPushPayload,
): Promise<WebhookHandlerResult> {
  const ref = payload.ref ?? "";
  if (!ref.startsWith("refs/heads/")) {
    return { success: true, event: "push", message: "Ignored non-branch ref" };
  }
  // Deleted branch
  if (payload.after === "0000000000000000000000000000000000000000") {
    return { success: true, event: "push", message: "Ignored deleted branch" };
  }

  const path =
    payload.project?.path_with_namespace ??
    (typeof payload.repository?.homepage === "string"
      ? payload.repository.homepage.replace(/^https?:\/\/[^/]+\//, "")
      : null);
  if (!path) {
    return { success: false, event: "push", error: "Missing project path" };
  }

  const parts = splitPathWithNamespace(path);
  if (!parts) {
    return { success: false, event: "push", error: "Invalid path_with_namespace" };
  }

  const branch = ref.replace(/^refs\/heads\//, "");
  const lastCommit = payload.commits?.[payload.commits.length - 1];
  const commitSha =
    payload.checkout_sha ||
    lastCommit?.id ||
    (payload.after && payload.after !== "0000000000000000000000000000000000000000"
      ? payload.after
      : null);

  return triggerBranchDeployments({
    event: "push",
    owner: parts.owner,
    repo: parts.repo,
    branch,
    commitSha,
    commitMessage: lastCommit?.message ?? lastCommit?.title ?? null,
    defaultBranch: payload.project?.default_branch ?? null,
  });
}
