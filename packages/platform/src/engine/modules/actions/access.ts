import { AppError, NotFoundError } from "@repo/core";
import { repos, type ActionRun, type ActionWorkflow } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { authorization } from "../../lib/authorization";
import { assertGitHubRepoAccess } from "../github/github-access";
import { resolveGitHubApiBaseUrl } from "../github/github-source.service";
import { assertJobServersWritable } from "../jobs/job-access";

export async function authorizeActionRepository(
  ctx: ExecutionContext,
  owner: string | null,
  repo: string | null,
): Promise<void> {
  if (!owner && !repo) return;
  if (!owner || !repo)
    throw new AppError(
      "Select a complete repository or use a standalone workflow",
      400,
      "ACTIONS_REPOSITORY_INVALID",
    );
  await assertGitHubRepoAccess(ctx, { owner, repo }, "read");
  const base = await resolveGitHubApiBaseUrl(ctx.organizationId, owner);
  // The pinned execution engine is configured for github.com. Never give a
  // GitHub Enterprise credential to a worker using a different GitHub host.
  if (base && base.replace(/\/$/, "") !== "https://api.github.com")
    throw new AppError(
      "Actions currently supports github.com repositories. GitHub Enterprise runners are not available yet.",
      422,
      "ACTIONS_GITHUB_HOST_UNSUPPORTED",
    );
}

export async function authorizeActionRunners(
  ctx: ExecutionContext,
  ids: string[],
  write: boolean,
): Promise<void> {
  if (!ids.length) throw new NotFoundError("Actions runner");
  for (const id of new Set(ids)) {
    const runner = await repos.actions.runner(ctx.organizationId, id);
    if (!runner) throw new NotFoundError("Actions runner", id);
    if (runner.serverId) {
      if (write) await assertJobServersWritable(ctx, [runner.serverId]);
      else
        await authorization.authorize(
          { ...ctx, scopeMode: "fixed" },
          { resourceType: "server", resourceId: runner.serverId, action: "read" },
        );
    } else {
      await authorization.authorize(
        { ...ctx, scopeMode: "fixed" },
        { resourceType: "job", resourceId: "*", action: write ? "admin" : "read" },
      );
    }
  }
}

export async function authorizeActionWorkflow(
  ctx: ExecutionContext,
  workflow: ActionWorkflow,
  write = false,
): Promise<void> {
  if (workflow.organizationId !== ctx.organizationId) throw new NotFoundError("Workflow");
  await authorizeActionRepository(ctx, workflow.owner, workflow.repo);
  await authorizeActionRunners(ctx, workflow.runnerIds, write);
}

export async function authorizeActionRun(
  ctx: ExecutionContext,
  run: ActionRun,
  write = false,
): Promise<void> {
  if (run.organizationId !== ctx.organizationId) throw new NotFoundError("Workflow run");
  await authorizeActionRepository(ctx, run.configuration.owner, run.configuration.repo);
  await authorizeActionRunners(ctx, run.configuration.runnerIds, write);
}

export async function visibleAction(check: () => Promise<void>): Promise<boolean> {
  try {
    await check();
    return true;
  } catch (error) {
    if (error instanceof AppError && [401, 403, 404].includes(error.statusCode)) return false;
    throw error;
  }
}
