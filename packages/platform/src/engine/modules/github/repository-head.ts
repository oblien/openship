import { AppError } from "@repo/core";
import type { Project } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { githubFetch } from "./github.auth";

export async function repositoryHead(ctx: ExecutionContext, project: Project, branch: string) {
  if (!project.gitOwner || !project.gitRepo)
    throw new AppError("The project no longer has a repository", 409, "ACTIONS_PROJECT_CHANGED");
  return (
    await githubFetch<{ sha: string }>({
      ctx,
      owner: project.gitOwner,
      repo: project.gitRepo,
      url: `https://api.github.com/repos/${encodeURIComponent(project.gitOwner)}/${encodeURIComponent(project.gitRepo)}/commits/${encodeURIComponent(`refs/heads/${branch}`)}`,
    })
  ).sha;
}
