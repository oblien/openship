import { ownedAgent, agentContainsGrants, approvedAssistantContext } from "./agent-access";
import { AppError } from "@repo/core";
import type { TCreateTokenBody, AutomationAction } from "@repo/contracts";
import { repos } from "@repo/db";
import { validateGrants } from "@repo/platform/engine/modules/tokens/token.service";
import { resolveSourceAccess } from "@repo/platform/engine/modules/github/github-access";
import type { RequestContext } from "../../lib/request-context";

export const repositoryAction = (action: string) =>
  action === "commit" || action === "pull_request";

/** A flow is a subset of BOTH the user's live membership and the existing Assistant consent. */
export async function automationGrants(
  ctx: RequestContext,
  projectId: string,
  actions: AutomationAction[],
  readRepository: boolean,
  agentId?: string | null,
) {
  const { ctx: approved } = await approvedAssistantContext(ctx);
  const agent = agentId ? await ownedAgent(ctx, agentId) : null;
  if (actions.length && approved.credential?.readOnly)
    throw new AppError(
      "Your assistant has read-only access. Review its permissions before allowing fixes.",
      403,
      "ASSISTANT_AUTOMATION",
    );
  const project = await repos.project.findByIdInOrganization(projectId, ctx.organizationId);
  if (!project) throw new AppError("App not found.", 404, "ASSISTANT_AUTOMATION");
  const grants: NonNullable<TCreateTokenBody["grants"]> = [
    {
      resourceType: "project",
      resourceId: projectId,
      permissions: [
        "read",
        ...(actions.some((a) => a === "restart" || a === "redeploy")
          ? ["deployments:trigger" as const]
          : []),
      ],
    },
  ];
  const writeSource = actions.some(repositoryAction);
  if (readRepository || writeSource || actions.includes("redeploy")) {
    if (readRepository || writeSource) {
      if (!project.gitOwner || !project.gitRepo)
        throw new AppError(
          "Connect this app to a GitHub repository to use source permissions.",
          400,
          "ASSISTANT_AUTOMATION",
        );
    }
    if (project.gitOwner && project.gitRepo) {
      const source = await resolveSourceAccess(approved, {
        owner: project.gitOwner,
        repo: project.gitRepo,
      });
      const agentSource = agent?.grants.find(
        (grant) =>
          grant.resourceType === "github_repository" &&
          grant.resourceId === `${project.gitOwner}/${project.gitRepo}`,
      )?.scope;
      const readPaths = agent ? (agentSource?.read?.paths ?? []) : source.readPaths;
      const writePaths = agent ? (agentSource?.write?.paths ?? []) : source.writePaths;
      if ((readRepository || writeSource) && !readPaths.length)
        throw new AppError(
          "Approve source read access to this app’s repository for the selected agent.",
          403,
          "ASSISTANT_AUTOMATION",
        );
      if (writeSource && !writePaths.length)
        throw new AppError(
          "Approve source write access to this app’s repository for the selected agent.",
          403,
          "ASSISTANT_AUTOMATION",
        );
      grants.push({
        resourceType: "github_repository",
        resourceId: `${project.gitOwner}/${project.gitRepo}`,
        permissions: [writeSource ? "write" : "read"],
        ...(readRepository || writeSource
          ? {
              scope: {
                v: 1,
                read: { paths: readPaths },
                ...(writeSource ? { write: { paths: writePaths } } : {}),
              },
            }
          : {}),
      });
    }
  }
  for (const principal of [ctx, approved]) {
    const denied = await validateGrants(principal, grants);
    if (denied)
      throw new AppError(
        "These permissions exceed your current Assistant or workspace access. Review the approved resources and source paths.",
        403,
        "ASSISTANT_AUTOMATION",
      );
  }
  if (agent && !agentContainsGrants(agent, grants, actions.length > 0))
    throw new AppError(
      "This flow exceeds the selected agent's permissions.",
      403,
      "ASSISTANT_AUTOMATION",
    );
  return grants;
}
