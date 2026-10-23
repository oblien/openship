import { randomUUID } from "node:crypto";
import {
  AppError,
  actionFinished,
  generateId,
  isFullCommitSha,
  safeErrorMessage,
} from "@repo/core";
import { diagnostics } from "@repo/core/diagnostics";
import { repos, type ActionDeploymentRequest, type Project } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import {
  captureExecutionAuthority,
  resolveExecutionAuthority,
} from "../../lib/execution-authority";
import { repositoryHead } from "../github/repository-head";
import type { DeploymentTriggerInput } from "../deployments/build.service";
import { automaticDeploymentIntent } from "../deployments/automatic-deployment-intent";
import { requireActionProject, getActionProjectPolicy } from "./project.service";
import {
  requireActionWorkflow,
  triggerActionWorkflow,
  rerunActionWorkflow,
} from "./action.service";
import { record } from "./workflow";
import { assertRequiredPushWorkflow } from "./required-checks";
import { authorization } from "../../lib/authorization";
import { notifyAutoDeployFailed } from "../github/queued-pushes";

async function requireDeploymentProject(ctx: ExecutionContext, request: ActionDeploymentRequest) {
  if (request.intent.kind !== "push") return requireActionProject(ctx, request.projectId, true);
  const target = await repos.project.findByIdInOrganization(request.projectId, ctx.organizationId);
  if (!target || target.deletedAt) throw new AppError("Project not found", 404, "NOT_FOUND");
  await authorization.authorize(
    { ...ctx, scopeMode: "fixed" },
    {
      resourceType: "project",
      resourceId: target.id,
      action: "write",
      capability: "deployments:trigger",
    },
  );
  return target;
}

/** Called at the same deployment entry used by signed pushes and authenticated webhook forwarding. */
export async function queueActionDeployment(
  ctx: ExecutionContext,
  project: Project,
  input: DeploymentTriggerInput,
) {
  if (!project.autoDeploy) return undefined;
  const required = (await repos.actions.projectWorkflows(ctx.organizationId, project.id)).filter(
    ({ link }) => link.required,
  );
  if (!required.length) return undefined;
  const branch = input.branch || project.gitBranch;
  if (!branch)
    throw new AppError(
      "Select a project branch before enabling required checks",
      409,
      "ACTIONS_BRANCH_REQUIRED",
    );
  const head = await repositoryHead(ctx, project, branch);
  const revision = input.commitSha || head;
  if (!isFullCommitSha(revision))
    throw new AppError(
      "The deployment commit could not be resolved",
      409,
      "ACTIONS_COMMIT_REQUIRED",
    );
  return repos.actions.queueActionDeployment({
    id: generateId("adep"),
    organizationId: ctx.organizationId,
    projectId: project.id,
    revision,
    ref: `refs/heads/${branch}`,
    requirements: {},
    authority: await captureExecutionAuthority(ctx),
    status: head === revision ? "waiting" : "superseded",
    error: head === revision ? null : "This push is older than the current repository branch.",
    intent: automaticDeploymentIntent(input),
  });
}

type GateRepo = Pick<
  typeof repos.actions,
  | "pendingActionDeployments"
  | "claimActionDeployment"
  | "renewActionDeployment"
  | "updateActionDeployment"
  | "deploymentForActionRequest"
  | "runsForActionDeployment"
>;
export interface ActionDeploymentPorts {
  repo: GateRepo;
  prepare(
    request: ActionDeploymentRequest,
  ): Promise<{ head: string; requirements: Record<string, string>; enabled: boolean }>;
  dispatchChecks(request: ActionDeploymentRequest, missingIds: string[]): Promise<void>;
  deploy(request: ActionDeploymentRequest, owner: string): Promise<string>;
  cancelObsolete?(request: ActionDeploymentRequest, owner: string): Promise<void>;
  failed?(request: ActionDeploymentRequest, error: unknown): void;
  reportError(error: unknown, request: ActionDeploymentRequest): void;
}

/** Durable lease + deployment receipt survive restarts without replaying an accepted deployment. */
export class ActionDeploymentController {
  private readonly owner = `actions-deploy-${randomUUID()}`;
  constructor(private readonly ports: ActionDeploymentPorts) {}
  async tick(now = new Date()) {
    const pending = await this.ports.repo.pendingActionDeployments(now);
    for (let i = 0; i < pending.length; i += 4)
      await Promise.all(pending.slice(i, i + 4).map((request) => this.reconcile(request, now)));
  }
  private async reconcile(candidate: ActionDeploymentRequest, now: Date) {
    const { repo } = this.ports;
    const request = await repo.claimActionDeployment(
      candidate.organizationId,
      candidate.id,
      this.owner,
      now,
    );
    if (!request) return;
    let lost = false;
    const timer = setInterval(() => {
      void repo
        .renewActionDeployment(request.organizationId, request.id, this.owner)
        .then((lease) => {
          if (!lease) lost = true;
        })
        .catch((error) => {
          lost = true;
          this.ports.reportError(error, request);
        });
    }, 30_000);
    timer.unref?.();
    const save = (
      status: ActionDeploymentRequest["status"],
      error: string | null,
      release = true,
      deploymentId?: string,
    ) =>
      lost
        ? Promise.resolve(undefined)
        : repo.updateActionDeployment(
            request.organizationId,
            request.id,
            this.owner,
            { status, error, deploymentId, retryAt: new Date(Date.now() + 15_000) },
            release,
          );
    try {
      const accepted = await repo.deploymentForActionRequest(request.organizationId, request.id);
      if (accepted) {
        if (accepted.status === "queued") await this.ports.deploy(request, this.owner);
        await save("deployed", null, true, accepted.id);
        return;
      }
      const current = await this.ports.prepare(request);
      const ids = Object.keys(request.requirements);
      if (
        !current.enabled ||
        current.head !== request.revision ||
        (!ids.length && request.intent.kind !== "push") ||
        Object.keys(current.requirements).length !== ids.length ||
        ids.some((id) => current.requirements[id] !== request.requirements[id])
      ) {
        await save(
          "superseded",
          "The branch or required workflow configuration changed. Waiting for a new push.",
        );
        return;
      }
      const runs = await repo.runsForActionDeployment(
        request.organizationId,
        ids,
        request.revision,
        request.ref,
      );
      const missing = ids.filter((id) => !runs.some((run) => run.workflowId === id));
      if (missing.length) {
        await this.ports.dispatchChecks(request, missing);
        await save("waiting", null);
        return;
      }
      if (
        runs.some(
          (run) => run.configuration.workflowVersion !== request.requirements[run.workflowId],
        )
      ) {
        await save(
          "superseded",
          "The required workflow configuration changed. Run checks for the current configuration.",
        );
        return;
      }
      for (const run of runs)
        assertRequiredPushWorkflow(run.plan, request.ref.replace(/^refs\/heads\//, ""));
      const failed = runs.find((run) => actionFinished(run.status) && run.status !== "success");
      if (failed) {
        await save(
          "blocked",
          `Required checks ${failed.status}. Retry the workflow or deploy manually.`,
        );
        return;
      }
      if (runs.some((run) => run.status !== "success")) {
        await save("waiting", null);
        return;
      }
      if (!(await save("deploying", null, false))) return;
      await this.ports.cancelObsolete?.(request, this.owner);
      const id = await this.ports.deploy(request, this.owner);
      await save("deployed", null, true, id);
    } catch (error) {
      const waiting =
        error instanceof AppError &&
        ["ACTIONS_CHECKS_PENDING", "DEPLOYMENT_IN_PROGRESS"].includes(error.code ?? "");
      if (!waiting) this.ports.reportError(error, request);
      const permanent =
        error instanceof AppError &&
        error.statusCode < 500 &&
        ![408, 429].includes(error.statusCode) &&
        !["ACTIONS_CHECKS_PENDING", "DEPLOYMENT_IN_PROGRESS"].includes(error.code ?? "");
      const saved = await save(
        permanent ? "failed" : "waiting",
        waiting ? null : safeErrorMessage(error),
      );
      if (saved && permanent) this.ports.failed?.(request, error);
    } finally {
      clearInterval(timer);
    }
  }
}

export const actionDeploymentController = new ActionDeploymentController({
  repo: repos.actions,
  async prepare(request) {
    const ctx = await resolveExecutionAuthority(
      request.authority,
      `actions-deployment:${request.id}`,
    );
    const project = await requireDeploymentProject(ctx, request);
    const links = (await repos.actions.projectWorkflows(ctx.organizationId, project.id)).filter(
      ({ link }) => link.required,
    );
    const branch = request.ref.replace(/^refs\/heads\//, "");
    const enabled =
      project.autoDeploy &&
      !project.disabledAt &&
      !project.deletionInProgress &&
      (!project.gitBranch || project.gitBranch === branch) &&
      (request.intent.kind !== "push" ||
        request.intent.repository === `${project.gitOwner}/${project.gitRepo}`.toLowerCase()) &&
      links.every(
        ({ workflow }) =>
          workflow.enabled &&
          workflow.owner === project.gitOwner?.toLowerCase() &&
          workflow.repo === project.gitRepo?.toLowerCase(),
      );
    // The default queue waits cheaply in the database. Do not poll GitHub for
    // a blocked push on every retry while its predecessor is still running.
    if (enabled && request.intent.kind === "push" && !project.autoDeployCancelBuilds)
      await (await import("../deployments/build.service")).checkNoActiveBuild(project.id);
    return {
      enabled: !!enabled,
      head: enabled ? await repositoryHead(ctx, project, branch) : "",
      requirements: Object.fromEntries(
        links.map(({ workflow }) => [workflow.id, workflow.updatedAt.toISOString()]),
      ),
    };
  },
  async dispatchChecks(request, ids) {
    for (const id of ids) {
      const saved = await repos.actions.workflow(request.organizationId, id);
      if (!saved)
        throw new AppError("Required workflow was removed", 409, "ACTIONS_WORKFLOW_REQUIRED");
      const ctx = await resolveExecutionAuthority(
        saved.authority,
        `actions-required:${request.id}:${id}`,
      );
      const workflow = await requireActionWorkflow(ctx, id, true);
      if (workflow.controller === "github") {
        // GitHub already owns the push. Reconcile it; dispatching here would
        // execute a second workflow with different GitHub event semantics.
        await (await import("./github-sync")).synchronizeGitHubWorkflow(ctx, workflow);
        continue;
      }
      await triggerActionWorkflow(ctx, workflow, {
        eventName: "push",
        key: request.id,
        revision: request.revision,
        ref: request.ref,
        requiredBranch: request.ref.replace(/^refs\/heads\//, ""),
        event: {
          ...request.intent.event,
          ref: request.ref,
          after: request.revision,
          head_commit: {
            ...record(request.intent.event?.head_commit),
            id: request.revision,
            message: request.intent.commitMessage ?? "",
          },
        },
      });
    }
  },
  async deploy(request, owner) {
    const ctx = await resolveExecutionAuthority(request.authority, `actions-deploy:${request.id}`);
    await requireDeploymentProject(ctx, request);
    const { event: _event, kind: _kind, repository: _repository, ...intent } = request.intent;
    const result = await (
      await import("../deployments/build.service")
    ).triggerDeployment(ctx, {
      ...intent,
      projectId: request.projectId,
      branch: request.ref.replace(/^refs\/heads\//, ""),
      commitSha: request.revision,
      trigger: request.intent.kind === "push" ? "webhook" : "actions",
      actionRequestId: request.id,
      actionLeaseOwner: owner,
    });
    if (!result.deployment)
      throw new AppError(
        "Deployment admission is still waiting for checks",
        409,
        "ACTIONS_CHECKS_PENDING",
      );
    return result.deployment.id;
  },
  async cancelObsolete(request, owner) {
    const ctx = await resolveExecutionAuthority(
      request.authority,
      `automatic-cancel:${request.id}`,
    );
    const project = await requireDeploymentProject(ctx, request);
    if (!project.autoDeployCancelBuilds) return;
    const [active] = await repos.deployment.listInFlightByProject(project.id);
    if (!active || active.commitSha === request.revision) return;
    await (
      await import("../deployments/build.service")
    ).cancelBuildSession(active.id, {
      automaticRequest: {
        projectId: project.id,
        organizationId: project.organizationId,
        requestId: request.id,
        owner,
      },
    });
  },
  failed(request, error) {
    if (request.intent.kind !== "push") return;
    void repos.project
      .findByIdInOrganization(request.projectId, request.organizationId)
      .then((project) => {
        if (project) notifyAutoDeployFailed(project, error);
      })
      .catch((error) =>
        diagnostics.warn(
          "actions/deployment",
          "Could not notify automatic deployment failure",
          error,
        ),
      );
  },
  reportError(error, request) {
    diagnostics.warn(
      "actions/deployment",
      "Automatic deployment request could not advance",
      error,
      {
        projectId: request.projectId,
        requestId: request.id,
      },
    );
  },
});

/** Explicit recovery reuses the receipt and run retry identities. No payment or deployment is replayed. */
export async function updateActionDeploymentRequest(
  ctx: ExecutionContext,
  input: Parameters<import("@repo/contracts").ActionOperations["updateDeploymentRequest"]>[0],
) {
  const project = await requireActionProject(ctx, input.projectId, true);
  const request = await repos.actions.actionDeployment(ctx.organizationId, input.requestId);
  if (!request || request.projectId !== project.id)
    throw new AppError("Deployment request not found", 404, "ACTIONS_DEPLOYMENT_NOT_FOUND");
  if (request.deploymentId)
    throw new AppError(
      "This request already started a deployment. Manage it in Deployments.",
      409,
      "ACTIONS_DEPLOYMENT_ACCEPTED",
    );
  if (input.action === "cancel") {
    const cancelled = await repos.actions.resetActionDeployment(
      ctx.organizationId,
      project.id,
      request.id,
      { status: "cancelled", error: null },
    );
    if (!cancelled)
      throw new AppError(
        "This request already started a deployment. Manage it in Deployments.",
        409,
        "ACTIONS_DEPLOYMENT_ACCEPTED",
      );
  } else {
    const branch = request.ref.replace(/^refs\/heads\//, "");
    if (
      !project.autoDeploy ||
      (project.gitBranch && project.gitBranch !== branch) ||
      (await repositoryHead(ctx, project, branch)) !== request.revision
    )
      throw new AppError(
        "This commit is no longer the automatic deployment target. Push a new commit or deploy manually.",
        409,
        "ACTIONS_DEPLOYMENT_CHANGED",
      );
    const links = (await repos.actions.projectWorkflows(ctx.organizationId, project.id)).filter(
      ({ link }) => link.required,
    );
    if (!links.length && request.intent.kind !== "push")
      throw new AppError("Select required workflows first", 409, "ACTIONS_WORKFLOW_REQUIRED");
    const requirements: Record<string, string> = {};
    for (const { workflow: saved } of links) {
      const workflow = await requireActionWorkflow(ctx, saved.id, true);
      assertRequiredPushWorkflow(workflow.definition, branch);
      requirements[workflow.id] = workflow.updatedAt.toISOString();
    }
    const runs = await repos.actions.runsForActionDeployment(
      ctx.organizationId,
      Object.keys(requirements),
      request.revision,
      request.ref,
    );
    for (const run of runs) {
      if (
        run.configuration.workflowVersion === requirements[run.workflowId] &&
        actionFinished(run.status) &&
        run.status !== "success"
      )
        await rerunActionWorkflow(ctx, run.id, `${request.id}-${input.idempotencyKey}`);
    }
    // Changed workflow versions get a new canonical push run, never an old green approval.
    for (const { workflow } of links) {
      if (
        !runs.some(
          (run) =>
            run.workflowId === workflow.id &&
            run.configuration.workflowVersion === requirements[workflow.id],
        )
      )
        if (workflow.controller === "github") {
          // GitHub already owns the push. Reconcile it; dispatching here would
          // execute a second workflow with different GitHub event semantics.
          await (await import("./github-sync")).synchronizeGitHubWorkflow(ctx, workflow);
          continue;
        }
      await triggerActionWorkflow(ctx, workflow, {
        eventName: "push",
        key: request.id,
        revision: request.revision,
        ref: request.ref,
        requiredBranch: branch,
        event: request.intent.event,
      });
    }
    const reset = await repos.actions.resetActionDeployment(
      ctx.organizationId,
      project.id,
      request.id,
      {
        status: "waiting",
        error: null,
        requirements,
        authority: await captureExecutionAuthority(ctx),
      },
    );
    if (!reset)
      throw new AppError(
        "This request already started a deployment. Manage it in Deployments.",
        409,
        "ACTIONS_DEPLOYMENT_ACCEPTED",
      );
  }
  return getActionProjectPolicy(ctx, project.id);
}
