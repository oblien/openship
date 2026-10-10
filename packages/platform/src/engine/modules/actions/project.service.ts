import { AppError, NotFoundError, ValidationError } from "@repo/core";
import { repos, type Project } from "@repo/db";
import type { ActionOperations } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { authorization } from "../../lib/authorization";
import { domainWebhookUrl } from "../../lib/public-url";
import { resolveWebhookStrategy } from "../github/github.service";
import { ensureSharedWebhook } from "../projects/project-git-webhook";
import { requireActionWorkflow } from "./action.service";
import { visibleAction } from "./access";
import { assertRequiredPushWorkflow } from "./required-checks";

export async function requireActionProject(ctx: ExecutionContext, id: string, write = false) {
  const project = await repos.project.findByIdInOrganization(id, ctx.organizationId);
  if (!project || project.deletedAt) throw new NotFoundError("Project", id);
  await authorization.authorize(
    { ...ctx, scopeMode: "fixed" },
    { resourceType: "project", resourceId: id, action: write ? "write" : "read" },
  );
  return project;
}

export async function authorizeActionProjects(ctx: ExecutionContext, ids: string[], write = false) {
  for (const id of new Set(ids)) await requireActionProject(ctx, id, write);
}

function projectView(project: Project) {
  return {
    id: project.id,
    name: project.name,
    owner: project.gitOwner,
    repo: project.gitRepo,
    branch: project.gitBranch,
  };
}

export async function listActionProjects(ctx: ExecutionContext) {
  const { rows } = await repos.project.listByOrganization(ctx.organizationId, { perPage: 1000 });
  const result = [];
  for (const project of rows)
    if (await visibleAction(() => requireActionProject(ctx, project.id).then(() => {})))
      result.push(projectView(project));
  return result;
}

export async function visibleWorkflowProjectIds(ctx: ExecutionContext, workflowId: string) {
  const result = [];
  for (const link of await repos.actions.workflowProjects(ctx.organizationId, workflowId))
    if (await visibleAction(() => requireActionProject(ctx, link.projectId).then(() => {})))
      result.push(link.projectId);
  return result;
}

export async function getActionProjectPolicy(ctx: ExecutionContext, projectId: string) {
  const project = await requireActionProject(ctx, projectId);
  const links = await repos.actions.projectWorkflows(ctx.organizationId, projectId);
  const workflowIds: string[] = [];
  for (const { workflow } of links)
    if (await visibleAction(() => requireActionWorkflow(ctx, workflow.id).then(() => {})))
      workflowIds.push(workflow.id);
  const required = links.filter(({ link }) => link.required).map(({ workflow }) => workflow.id);
  return {
    project: projectView(project),
    mode: !project.autoDeploy
      ? ("manual" as const)
      : required.length
        ? ("actions" as const)
        : ("push" as const),
    workflowIds,
    requiredWorkflowIds: required.filter((id) => workflowIds.includes(id)),
    requests: (await repos.actions.projectActionDeployments(ctx.organizationId, projectId)).map(
      (request) => ({
        id: request.id,
        projectId,
        revision: request.revision,
        ref: request.ref,
        status: request.status,
        error: request.error,
        deploymentId: request.deploymentId,
        createdAt: request.createdAt,
        workflowIds: Object.keys(request.requirements).filter((id) => workflowIds.includes(id)),
      }),
    ),
  };
}

export async function updateActionProjectPolicy(
  ctx: ExecutionContext,
  input: Parameters<ActionOperations["updateProjectPolicy"]>[0],
) {
  const project = await requireActionProject(ctx, input.projectId, true);
  const linked = new Set(input.workflowIds);
  if (input.requiredWorkflowIds.some((id) => !linked.has(id)))
    throw new ValidationError("Required workflows must be linked to this project");
  if (input.mode === "actions" && !input.requiredWorkflowIds.length)
    throw new ValidationError("Select at least one required workflow");
  if (input.mode !== "actions" && input.requiredWorkflowIds.length)
    throw new ValidationError("Required checks need Deploy after Actions pass");
  // Changing a policy must not silently detach a workflow the editor cannot access.
  const previous = await repos.actions.projectWorkflows(ctx.organizationId, project.id);
  let needsOpenshipChecks = false;
  for (const id of new Set([
    ...input.workflowIds,
    ...previous.map(({ workflow }) => workflow.id),
  ])) {
    const workflow = await requireActionWorkflow(ctx, id, true);
    if (!input.requiredWorkflowIds.includes(id)) continue;
    if (workflow.controller !== "github") needsOpenshipChecks = true;
    if (
      !workflow.enabled ||
      !workflow.owner ||
      !workflow.repo ||
      workflow.owner.toLowerCase() !== project.gitOwner?.toLowerCase() ||
      workflow.repo.toLowerCase() !== project.gitRepo?.toLowerCase()
    )
      throw new ValidationError(
        "Required checks must be enabled workflows from the project's repository",
      );
    assertRequiredPushWorkflow(
      workflow.definition,
      project.gitBranch || workflow.ref,
      workflow.name,
    );
  }
  if (input.mode !== "manual") {
    if (!project.gitOwner || !project.gitRepo)
      throw new ValidationError("Connect a repository before enabling automatic deployments");
    const strategy = await resolveWebhookStrategy(project, ctx.organizationId);
    if (strategy === "none")
      throw new AppError(
        "Publish this instance to receive GitHub pushes before enabling automatic deployments",
        409,
        "ACTIONS_PUBLIC_INSTANCE_REQUIRED",
      );
    if (
      input.mode === "actions" &&
      needsOpenshipChecks &&
      !(await repos.gitInstallation.findByOrgAndOwner(ctx.organizationId, project.gitOwner))
    )
      throw new AppError(
        "Connect a GitHub App for this repository to run required checks and receive its push events",
        409,
        "ACTIONS_GITHUB_APP_REQUIRED",
      );
    if (
      strategy !== "app" &&
      !(await ensureSharedWebhook(
        ctx,
        project,
        project.gitOwner,
        project.gitRepo,
        strategy === "domain" ? domainWebhookUrl(project.webhookDomain!) : undefined,
      ))
    )
      throw new AppError(
        "Could not register the repository webhook. Check your GitHub access and try again.",
        403,
        "ACTIONS_WEBHOOK_UNAVAILABLE",
      );
  }
  await repos.actions.configureProject(ctx.organizationId, project.id, {
    enabled: input.mode !== "manual",
    workflowIds: input.workflowIds,
    requiredWorkflowIds: input.requiredWorkflowIds,
  });
  return getActionProjectPolicy(ctx, project.id);
}
