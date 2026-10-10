import { actionFinished, NotFoundError, ValidationError } from "@repo/core";
import { repos } from "@repo/db";
import type { ActionDependencies } from "../../../actions";
import type { ExecutionContext } from "../../../context";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { assertNativeJobs } from "../../native/execution-policy";
import {
  authorizeActionRunners,
  authorizeActionRun,
  authorizeActionWorkflow,
  visibleAction,
} from "./access";
import * as service from "./action.service";
import { actionPlanView, actionRunnerView, actionRunView, actionWorkflowView } from "./views";
import { parseActionWorkflow } from "./workflow";
import {
  enableActionEmulation,
  inspectActionDestination,
  probeActionRunner,
  saveActionRunner,
} from "./runner.service";
import { actionArtifacts, actionArtifactDownload } from "./storage";
import {
  getActionProjectPolicy,
  updateActionProjectPolicy,
  listActionProjects,
  requireActionProject,
  visibleWorkflowProjectIds,
} from "./project.service";
import { readActionRepositorySource, updateActionRepositorySource } from "./repository-source";

function record(ctx: ExecutionContext, id: string, operation: string) {
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "job:write",
    resourceType: "job",
    resourceId: id,
    after: { module: "actions", operation },
  });
}
async function presentRun(ctx: ExecutionContext, id: string) {
  const run = await service.requireActionRun(ctx, id);
  return actionRunView(run, await repos.actions.jobs(ctx.organizationId, id));
}
async function presentWorkflow(
  ctx: ExecutionContext,
  row: Awaited<ReturnType<typeof service.requireActionWorkflow>>,
) {
  return { ...actionWorkflowView(row), projectIds: await visibleWorkflowProjectIds(ctx, row.id) };
}

export const actionDependencies: ActionDependencies = {
  collection: {
    updateDeploymentRequest: async (ctx, input) => {
      const result = await (
        await import("./deployment-gate")
      ).updateActionDeploymentRequest(ctx, input);
      record(ctx, input.projectId, `deployment-${input.action}`);
      return result;
    },
    async list(ctx, input = {}) {
      if (input.projectId) await requireActionProject(ctx, input.projectId);
      const result = [];
      for (const row of await repos.actions.listWorkflows(ctx.organizationId, input.projectId))
        if (await visibleAction(() => authorizeActionWorkflow(ctx, row)))
          result.push(await presentWorkflow(ctx, row));
      return result;
    },
    async create(ctx, input) {
      const row = await service.saveActionWorkflow(ctx, input);
      record(ctx, row.id, "create");
      return presentWorkflow(ctx, row);
    },
    async listRuns(ctx, input = {}) {
      if (input.workflowId) await service.requireActionWorkflow(ctx, input.workflowId);
      if (input.projectId) await requireActionProject(ctx, input.projectId);
      const result = [];
      for (const run of await repos.actions.runs(
        ctx.organizationId,
        input.workflowId,
        input.limit,
        input.projectId,
      ))
        if (await visibleAction(() => authorizeActionRun(ctx, run)))
          result.push(actionRunView(run, await repos.actions.jobs(ctx.organizationId, run.id)));
      return result;
    },
    async runners(ctx) {
      const result = [];
      for (const row of await repos.actions.listRunners(ctx.organizationId))
        if (await visibleAction(() => authorizeActionRunners(ctx, [row.id], false)))
          result.push(actionRunnerView(row));
      return result;
    },
    async addRunner(ctx, input) {
      const row = await saveActionRunner(ctx, input);
      record(ctx, row.id, "add-runner");
      return actionRunnerView(row);
    },
    inspectDestination: (ctx, input) => inspectActionDestination(ctx, input.serverId),
    enableEmulation: (ctx, input) => enableActionEmulation(ctx, input.serverId),
    async preview(_ctx, input) {
      return actionPlanView(await parseActionWorkflow(input.source, input.path, input.controller));
    },
    discover: (ctx, input) =>
      service.discoverActionWorkflows(ctx, input.owner, input.repo, input.ref),
    repositorySource: readActionRepositorySource,
    async updateRepositorySource(ctx, input) {
      const result = await updateActionRepositorySource(ctx, input);
      record(ctx, `${input.owner}/${input.repo}/${input.path}`, "update-source");
      return result;
    },
    projects: listActionProjects,
    projectPolicy: (ctx, input) => getActionProjectPolicy(ctx, input.projectId),
    async updateProjectPolicy(ctx, input) {
      const result = await updateActionProjectPolicy(ctx, input);
      record(ctx, input.projectId, "deployment-policy");
      return result;
    },
  },
  resources: {
    async get(ctx, id) {
      return presentWorkflow(ctx, await service.requireActionWorkflow(ctx, id));
    },
    async update(ctx, id, input) {
      const row = await service.saveActionWorkflow(ctx, input, id);
      record(ctx, id, "update");
      return presentWorkflow(ctx, row);
    },
    async remove(ctx, id) {
      await service.requireActionWorkflow(ctx, id, true);
      await repos.actions.disableWorkflow(ctx.organizationId, id);
      record(ctx, id, "disable");
      return { success: true };
    },
    async dispatch(ctx, id, input) {
      assertNativeJobs();
      const workflow = await service.requireActionWorkflow(ctx, id, true);
      if (input.clientPayload && !input.eventType)
        throw new ValidationError("clientPayload requires an eventType");
      if (input.eventType && input.inputs)
        throw new ValidationError("Webhook events use clientPayload; manual runs use inputs");
      if (Buffer.byteLength(JSON.stringify(input.clientPayload ?? {})) > 65536)
        throw new ValidationError("Webhook payload exceeds 64 KiB");
      const run = await service.triggerActionWorkflow(ctx, workflow, {
        eventName: input.eventType ? "repository_dispatch" : "workflow_dispatch",
        event: input.eventType
          ? { action: input.eventType, client_payload: input.clientPayload ?? {} }
          : undefined,
        key: input.idempotencyKey,
        ref: input.ref,
        inputs: input.inputs,
      });
      record(ctx, run.id, "dispatch");
      return presentRun(ctx, run.id);
    },
    getRun: presentRun,
    async artifacts(ctx, id) {
      return actionArtifacts(ctx, await service.requireActionRun(ctx, id));
    },
    async artifactDownload(ctx, id, input) {
      return actionArtifactDownload(ctx, await service.requireActionRun(ctx, id), input.artifactId);
    },
    async cancel(ctx, id) {
      const run = await service.requireActionRun(ctx, id, true);
      if (run.controller === "github")
        await (await import("./github-commands")).controlGitHubRun(ctx, run, "cancel");
      else await repos.actions.requestCancel(ctx.organizationId, id);
      record(ctx, id, "cancel");
      return presentRun(ctx, id);
    },
    async approve(ctx, id) {
      const run = await service.requireActionRun(ctx, id, true);
      if (run.controller === "github")
        await (await import("./github-commands")).controlGitHubRun(ctx, run, "approve");
      else await repos.actions.approve(ctx.organizationId, id, ctx.userId);
      record(ctx, id, "approve");
      return presentRun(ctx, id);
    },
    async rerun(ctx, id, input) {
      assertNativeJobs();
      const run = await service.rerunActionWorkflow(ctx, id, input.idempotencyKey);
      record(ctx, run.id, "rerun");
      return presentRun(ctx, run.id);
    },
    async updateRunner(ctx, id, input) {
      const row = await saveActionRunner(ctx, input, id);
      record(ctx, id, "update-runner");
      return actionRunnerView(row);
    },
    async removeRunner(ctx, id) {
      await authorizeActionRunners(ctx, [id], true);
      await repos.actions.disableRunner(ctx.organizationId, id);
      record(ctx, id, "disable-runner");
      return { success: true };
    },
    async probeRunner(ctx, id) {
      return actionRunnerView(await probeActionRunner(ctx, id));
    },
    async jobEvents(ctx, id, input = {}) {
      const job = await repos.actions.job(ctx.organizationId, id);
      if (!job) throw new NotFoundError("Workflow job", id);
      const run = await service.requireActionRun(ctx, job.runId);
      if (run.controller === "github")
        return (await import("./github-output")).gitHubJobEvents(ctx, run, job, input.after ?? 0);
      const rows = await repos.actions.events(ctx.organizationId, id, input.after);
      // The worker may advance past lines discarded by the log byte budget.
      // Once this page drains saved rows, acknowledge that durable cursor too.
      const next =
        rows.length < 250
          ? Math.max(rows.at(-1)?.sequence ?? input.after ?? 0, job.lastEventSequence)
          : rows.at(-1)!.sequence;
      return {
        events: rows.map((row) => row.event),
        next,
        complete: actionFinished(job.status) && next >= job.lastEventSequence,
      };
    },
  },
};
