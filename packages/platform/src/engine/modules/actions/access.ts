import { DEFAULT_GIT_PROVIDER, AppError, NotFoundError } from "@repo/core";
import { repos, type ActionRun, type ActionWorkflow } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { authorization } from "../../lib/authorization";
import { requireGitCapability } from "../git/provider";
import { actionRepository } from "./repository";
export { actionRepository } from "./repository";
import { assertJobServersWritable } from "../jobs/job-access";

export async function authorizeActionRepository(
  ctx: ExecutionContext,
  owner: string | null,
  repo: string | null,
  provider = DEFAULT_GIT_PROVIDER,
): Promise<void> {
  if (!owner && !repo) return;
  if (!owner || !repo)
    throw new AppError(
      "Select a complete repository or use a standalone workflow",
      400,
      "ACTIONS_REPOSITORY_INVALID",
    );
  const source = actionRepository(ctx, { owner, repo, gitProvider: provider });
  await source.assertAccess("read");
  await requireGitCapability(source.workflows, "workflow execution").assertExecution();
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
  await authorizeActionRepository(ctx, workflow.owner, workflow.repo, workflow.gitProvider);
  await authorizeActionRunners(ctx, workflow.runnerIds, write);
}

export async function authorizeActionRun(
  ctx: ExecutionContext,
  run: ActionRun,
  write = false,
): Promise<void> {
  if (run.organizationId !== ctx.organizationId) throw new NotFoundError("Workflow run");
  await authorizeActionRepository(ctx, run.configuration.owner, run.configuration.repo, run.configuration.gitProvider);
  if (write) {
    const checked = new Set([`${run.configuration.gitProvider ?? DEFAULT_GIT_PROVIDER}:${run.configuration.owner}/${run.configuration.repo}`.toLowerCase()]);
    for (const source of Object.values(run.configuration.workflows ?? {})) {
      const repository = `${source.gitProvider ?? run.configuration.gitProvider ?? DEFAULT_GIT_PROVIDER}:${source.owner}/${source.repo}`.toLowerCase();
      if (checked.has(repository)) continue;
      await authorizeActionRepository(ctx, source.owner, source.repo, source.gitProvider ?? run.configuration.gitProvider);
      checked.add(repository);
    }
  }
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
