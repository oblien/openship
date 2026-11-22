import type { Project } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { projectRepository } from "../git/provider";

/** Compatibility entry point for existing Actions callers. */
export async function repositoryHead(ctx: ExecutionContext, project: Project, branch: string) {
  return projectRepository(ctx, project).head(branch);
}
