import { actionFinished, NotFoundError } from "@repo/core";
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
import { inspectActionDestination, probeActionRunner, saveActionRunner } from "./runner.service";
import { actionArtifacts, actionArtifactDownload } from "./storage";

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

export const actionDependencies: ActionDependencies = {
  collection: {
    async list(ctx) {
      const result = [];
      for (const row of await repos.actions.listWorkflows(ctx.organizationId))
        if (await visibleAction(() => authorizeActionWorkflow(ctx, row)))
          result.push(actionWorkflowView(row));
      return result;
    },
    async create(ctx, input) {
      const row = await service.saveActionWorkflow(ctx, input);
      record(ctx, row.id, "create");
      return actionWorkflowView(row);
    },
    async listRuns(ctx, input = {}) {
      if (input.workflowId) await service.requireActionWorkflow(ctx, input.workflowId);
      const result = [];
      for (const run of await repos.actions.runs(ctx.organizationId, input.workflowId, input.limit))
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
    async preview(_ctx, input) {
      return actionPlanView(await parseActionWorkflow(input.source, input.path));
    },
    discover: (ctx, input) =>
      service.discoverActionWorkflows(ctx, input.owner, input.repo, input.ref),
  },
  resources: {
    async get(ctx, id) {
      return actionWorkflowView(await service.requireActionWorkflow(ctx, id));
    },
    async update(ctx, id, input) {
      const row = await service.saveActionWorkflow(ctx, input, id);
      record(ctx, id, "update");
      return actionWorkflowView(row);
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
      const run = await service.triggerActionWorkflow(ctx, workflow, {
        eventName: "workflow_dispatch",
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
      await service.requireActionRun(ctx, id, true);
      await repos.actions.requestCancel(ctx.organizationId, id);
      record(ctx, id, "cancel");
      return presentRun(ctx, id);
    },
    async approve(ctx, id) {
      await service.requireActionRun(ctx, id, true);
      await repos.actions.approve(ctx.organizationId, id, ctx.userId);
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
      await service.requireActionRun(ctx, job.runId);
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
