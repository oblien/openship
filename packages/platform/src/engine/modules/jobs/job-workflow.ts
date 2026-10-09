/** Jobs selects when; Actions owns the immutable run, runner, logs and retry state. */
import { createHash, randomUUID } from "node:crypto";
import { AppError, NotFoundError, ValidationError, actionFinished } from "@repo/core";
import { repos, type ActionRun, type Job, type JobRun } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import {
  captureExecutionAuthority,
  resolveExecutionAuthority,
} from "../../lib/execution-authority";
import { assertNativeJobs } from "../../native/execution-policy";
import { workflowJobConfig, type WorkflowJobConfig, type JobNotifyConfig } from "./job.types";

export async function authorizeWorkflowJob(ctx: ExecutionContext, row: Job, write = false) {
  const config = workflowJobConfig(row);
  if (!config || config.authority.organizationId !== ctx.organizationId)
    throw new NotFoundError("Job");
  await (
    await import("../actions/action.service")
  ).requireActionWorkflow(ctx, config.workflowId, write);
  return config;
}

export async function configureWorkflowJob(
  ctx: ExecutionContext,
  input: { workflowId: string; inputs?: Record<string, string> },
): Promise<WorkflowJobConfig> {
  const { requireActionWorkflow, validateActionDispatchInputs } =
    await import("../actions/action.service");
  const workflow = await requireActionWorkflow(ctx, input.workflowId, true);
  if (!("workflow_dispatch" in workflow.definition.triggers))
    throw new ValidationError(
      "Enable manual runs (workflow_dispatch) on this workflow before linking a job",
    );
  await validateActionDispatchInputs(ctx, workflow, input.inputs ?? {});
  return {
    workflowId: workflow.id,
    inputs: input.inputs ?? {},
    authority: await captureExecutionAuthority(ctx),
  };
}

export async function startWorkflowJob(
  row: Job,
  trigger: string,
  identity?: string,
): Promise<string> {
  assertNativeJobs();
  const config = workflowJobConfig(row);
  if (!config)
    throw new AppError(
      "Reconfigure this workflow job before running it",
      409,
      "ACTION_REAUTHORIZATION_REQUIRED",
    );
  const ctx = await resolveExecutionAuthority(config.authority, `job:${row.key}`);
  await authorizeWorkflowJob(ctx, row, true);
  const { requireActionWorkflow, triggerActionWorkflow } =
    await import("../actions/action.service");
  const workflow = await requireActionWorkflow(ctx, config.workflowId, true);
  // Timer replay and one-shot recovery converge; deliberate manual runs have new identities.
  const slot =
    identity ??
    (trigger === "schedule"
      ? String(Math.floor(Date.now() / 60_000))
      : trigger === "once"
        ? (row.runAt?.toISOString() ?? row.updatedAt.toISOString())
        : randomUUID());
  const key = createHash("sha256")
    .update(`${row.key}:${row.updatedAt.toISOString()}:${trigger}:${slot}`)
    .digest("hex");
  const run = await triggerActionWorkflow(ctx, workflow, {
    eventName: "workflow_dispatch",
    key,
    inputs: config.inputs,
    sourceJob: {
      key: row.key,
      label: row.label,
      trigger,
      notifyConfig: row.notifyConfig as JobNotifyConfig | null,
    },
  });
  return run.id;
}

/** Project the same persisted execution, rather than maintaining a second run state. */
export function workflowJobRunView(run: ActionRun): JobRun {
  return {
    id: run.id,
    jobId: run.configuration.sourceJob!.key,
    kind: "workflow",
    trigger: run.configuration.sourceJob!.trigger,
    status: !actionFinished(run.status)
      ? "running"
      : run.status === "success"
        ? "success"
        : "failed",
    serverId: null,
    serverIds: null,
    attempt: run.attempt,
    startedAt: run.startedAt ?? run.createdAt,
    finishedAt: run.finishedAt,
    durationMs: run.finishedAt
      ? run.finishedAt.getTime() - (run.startedAt ?? run.createdAt).getTime()
      : null,
    summary: { workflowId: run.workflowId, actionRunId: run.id, status: run.status },
    output: null,
    error: run.error,
    createdAt: run.createdAt,
  };
}

export async function workflowJobRuns(row: Job, limit = 50): Promise<JobRun[]> {
  const config = workflowJobConfig(row);
  if (!config) return [];
  return (await repos.actions.runsForJob(config.authority.organizationId, row.key, limit)).map(
    workflowJobRunView,
  );
}

export async function workflowJobCompleted(run: ActionRun) {
  const source = run.configuration.sourceJob;
  if (!source) return;
  const { emitJobRun, fireDependents } = await import("./job-command");
  const row = { key: source.key, label: source.label, notifyConfig: source.notifyConfig } as Job;
  await emitJobRun(
    row,
    run.id,
    run.status === "success" ? "success" : "failed",
    run.organizationId,
    { durationMs: workflowJobRunView(run).durationMs ?? undefined, error: run.error ?? undefined },
  );
  if (run.status === "success") await fireDependents(source.key, run.organizationId, run.id);
}
