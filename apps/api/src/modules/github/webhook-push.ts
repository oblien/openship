/** Normalize an authenticated GitHub branch push for the shared deployment pipeline. */
import { webhookRepository } from "@repo/platform/engine/modules/github/webhook-repository";
import type { GitHubPushPayload } from "@repo/contracts";
import type { WebhookHandlerResult } from "@repo/platform/engine/modules/webhooks/webhook.types";
import { extractChangedFiles } from "@repo/platform/engine/modules/github/webhook-changed-files";
import { triggerBranchDeployments } from "../git/webhook-push";

export async function handlePush(
  payload: GitHubPushPayload,
  handledProjectIds: Set<string> = new Set(),
  organizationIds?: readonly string[],
): Promise<WebhookHandlerResult> {
  const repository = webhookRepository(payload);
  const ref = payload.ref;
  const commitSha = payload.head_commit?.id;
  const defaultBranch = payload.repository?.default_branch;

  if (!repository) {
    return { success: false, event: "push", error: "Missing repository info in payload" };
  }

  if (payload.deleted) {
    return { success: true, event: "push", message: "Ignoring deleted branch push" };
  }

  if (!ref?.startsWith("refs/heads/")) {
    return {
      success: true,
      event: "push",
      message: `Ignoring non-branch ref: ${ref ?? "unknown"}`,
    };
  }

  const branch = ref.replace("refs/heads/", "");

  return triggerBranchDeployments(
    {
      event: "push",
      repository,
      branch,
      defaultBranch,
      commitSha,
      commitMessage: payload.head_commit?.message,
      organizationIds,
      matchesProject: (project) =>
        payload.installation?.id == null || project.installationId === payload.installation.id,
      actionEvent: { ...payload },
      changes: (repository, options) =>
        extractChangedFiles(payload, {
          ...options,
          compareCommits: (_owner, _repo, base, head) => repository.compare(base, head),
        }),
    },
    handledProjectIds,
  );
}
