import { AppError, safeErrorMessage, inferActionWorkflowController } from "@repo/core";
import type { ActionOperations } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { requireGitCapability } from "../git/provider";
import { actionRepository, authorizeActionRepository } from "./access";
import { parseActionWorkflow } from "./workflow";
import { actionPlanView } from "./views";

export async function readActionRepositorySource(
  ctx: ExecutionContext,
  input: Parameters<ActionOperations["repositorySource"]>[0],
) {
  await authorizeActionRepository(ctx, input.owner, input.repo, input.gitProvider);
  const file = await actionRepository(ctx, input).file(input.path, input.ref);
  try {
    return {
      source: file.content,
      sha: file.sha,
      plan: actionPlanView(
        await parseActionWorkflow(
          file.content,
          input.path,
          input.controller ?? inferActionWorkflowController(input.path),
        ),
      ),
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
  await authorizeActionRepository(ctx, input.owner, input.repo, input.gitProvider);
  await actionRepository(ctx, input).assertAccess("write");
  await parseActionWorkflow(
    input.source,
    input.path,
    input.controller ?? inferActionWorkflowController(input.path),
  );
  const branch = input.ref.replace(/^refs\/heads\//, "");
  if (input.ref.startsWith("refs/") && !input.ref.startsWith("refs/heads/"))
    throw new AppError("Choose a branch to edit this workflow", 400, "ACTIONS_BRANCH_REQUIRED");
  return requireGitCapability(actionRepository(ctx, input).workflows, "workflow editing").updateFile({
    branch, path: input.path, sha: input.sha, content: input.source,
    message: `Configure ${input.path} for Openship Actions`,
  });
}
