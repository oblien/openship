import { AppError, safeErrorMessage } from "@repo/core";
import type { ActionOperations } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { githubFetch } from "../github/github.auth";
import { getFileContent } from "../github/github.service";
import { assertGitHubRepoAccess } from "../github/github-access";
import { authorizeActionRepository } from "./access";
import { parseActionWorkflow } from "./workflow";
import { actionPlanView } from "./views";

export async function readActionRepositorySource(
  ctx: ExecutionContext,
  input: Parameters<ActionOperations["repositorySource"]>[0],
) {
  await authorizeActionRepository(ctx, input.owner, input.repo);
  const file = await getFileContent(ctx, input.owner, input.repo, input.path, {
    branch: input.ref,
  });
  try {
    return {
      source: file.content,
      sha: file.sha,
      plan: actionPlanView(await parseActionWorkflow(file.content, input.path)),
      error: null,
    };
  } catch (error) {
    // Keep unsupported workflow files selectable and explain the actual limitation.
    if (!(error instanceof AppError) || error.statusCode >= 500) throw error;
    return { source: file.content, sha: file.sha, plan: null, error: safeErrorMessage(error) };
  }
}

export async function updateActionRepositorySource(
  ctx: ExecutionContext,
  input: Parameters<ActionOperations["updateRepositorySource"]>[0],
) {
  await authorizeActionRepository(ctx, input.owner, input.repo);
  await assertGitHubRepoAccess(ctx, input, "write");
  await parseActionWorkflow(input.source, input.path);
  const base = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
  // Only named branches may be changed. GitHub's contents SHA rejects concurrent edits.
  const branch = input.ref.replace(/^refs\/heads\//, "");
  if (input.ref.startsWith("refs/") && !input.ref.startsWith("refs/heads/"))
    throw new AppError("Choose a branch to edit this workflow", 400, "ACTIONS_BRANCH_REQUIRED");
  const result = await githubFetch<{ content: { sha: string }; commit: { sha: string } }>({
    ctx,
    owner: input.owner,
    repo: input.repo,
    url: `${base}/contents/${input.path.split("/").map(encodeURIComponent).join("/")}`,
    method: "PUT",
    params: {
      branch,
      sha: input.sha,
      content: Buffer.from(input.source).toString("base64"),
      message: `Configure ${input.path} for Openship Actions`,
    },
  });
  return { sha: result.content.sha, commit: result.commit.sha };
}
