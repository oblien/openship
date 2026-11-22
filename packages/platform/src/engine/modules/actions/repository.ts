import { DEFAULT_GIT_PROVIDER, AppError } from "@repo/core";
import type { ExecutionContext } from "../../../context";
import { gitRepository } from "../git/provider";

/** Legacy workflow snapshots default to their original provider only. */
export function actionRepository(
  ctx: ExecutionContext,
  source: { owner: string | null; repo: string | null; gitProvider?: string | null },
) {
  if (!source.owner || !source.repo)
    throw new AppError("This workflow has no repository", 400, "ACTIONS_REPOSITORY_INVALID");
  return gitRepository(ctx, {
    provider: source.gitProvider ?? DEFAULT_GIT_PROVIDER,
    namespace: source.owner,
    name: source.repo,
  });
}
