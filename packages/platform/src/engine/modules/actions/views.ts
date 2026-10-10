import { actionFinished, actionRunnerLabels, type ActionWorkflowPlan } from "@repo/core";
import type { ActionJob, ActionRun, ActionRunner, ActionWorkflow } from "@repo/db";
import { record } from "./workflow";

export function actionPlanView(plan: ActionWorkflowPlan) {
  return {
    name: plan.name,
    triggers: Object.keys(plan.triggers),
    triggerRules: plan.triggers,
    jobs: plan.jobs.map(({ id, name, needs, runsOn, requiresDocker, uses }) => ({
      id,
      name,
      needs,
      // Reusable jobs delegate their runner to the called workflow. Keep the
      // required response field present after JSON serialization.
      runsOn: runsOn ?? null,
      requiresDocker,
      ...(uses && { uses }),
    })),
    inputs: Object.entries(record(record(plan.triggers.workflow_dispatch).inputs)).map(
      ([name, value]) => {
        const input = record(value);
        return {
          name,
          type: String(input.type ?? "string"),
          description: String(input.description ?? ""),
          required: input.required === true,
          default: String(input.default ?? (input.type === "boolean" ? "false" : "")),
          options: Array.isArray(input.options) ? input.options.map(String) : [],
        };
      },
    ),
  };
}
export function actionRunnerView(runner: ActionRunner) {
  return {
    id: runner.id,
    name: runner.name,
    serverId: runner.serverId,
    kind: runner.cloudPoolId ? "cloud" : "server",
    config: runner.config,
    capabilities: runner.capabilities,
    enabled: runner.enabled,
    checkedAt: runner.checkedAt,
    error: runner.error,
    labels: runner.capabilities ? actionRunnerLabels(runner.capabilities, runner.config) : [],
  };
}
export function actionWorkflowView(workflow: ActionWorkflow) {
  const {
    id,
    name,
    owner,
    repo,
    path,
    ref,
    source,
    runnerIds,
    variables,
    enabled,
    allowForks,
    createdAt,
    updatedAt,
  } = workflow;
  return {
    id,
    controller: workflow.controller ?? "openship",
    githubWorkflowId: workflow.githubWorkflowId ?? null,
    name,
    owner,
    repo,
    path,
    ref,
    source,
    runnerIds,
    storageDestinationId: workflow.storageDestinationId,
    variables,
    plan: actionPlanView(workflow.definition),
    lastError: workflow.lastError,
    enabled,
    allowForks,
    createdAt,
    updatedAt,
    secretNames: Object.keys(workflow.secrets),
  };
}
export function actionRunView(run: ActionRun, jobs: ActionJob[]) {
  return {
    id: run.id,
    controller: run.controller ?? "openship",
    externalUrl: run.github?.url ?? null,
    workflowId: run.workflowId,
    name: run.plan.name,
    number: run.number,
    attempt: run.attempt,
    status: run.status,
    owner: run.configuration.owner,
    repo: run.configuration.repo,
    revision: run.revision,
    ref: run.ref,
    eventName: run.eventName,
    actor: run.actor,
    untrusted: run.untrusted,
    approvedAt: run.approvedAt,
    cancelRequestedAt: run.cancelRequestedAt,
    error: run.error,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    settledAt: run.settledAt,
    createdAt: run.createdAt,
    plan: actionPlanView(run.plan),
    jobs: jobs.map((job) => ({
      id: job.id,
      externalUrl: job.github?.url ?? null,
      jobKey: job.jobKey,
      name: job.spec?.name ?? job.jobKey,
      matrixIndex: job.matrixIndex,
      matrix: job.spec?.matrix ?? {},
      labels: job.spec?.labels ?? [],
      status: job.status,
      phase: actionFinished(job.status)
        ? ("finished" as const)
        : job.workerStartedAt || (job.github && job.status === "running")
          ? ("running" as const)
          : job.runnerId
            ? ("provisioning" as const)
            : ("queued" as const),
      runnerId: job.runnerId,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      cleanedAt: job.cleanedAt,
      error: job.error,
      checkRunId: job.checkRunId,
      checkError: job.checkError,
      logBytes: job.logBytes,
      lastEventSequence: job.lastEventSequence,
      outputs: job.result?.outputs ?? {},
      steps: job.github
        ? Object.fromEntries(
            job.github.steps.map((step) => [
              String(step.number),
              {
                name: step.name,
                outcome: step.conclusion ?? (step.status === "in_progress" ? "running" : "queued"),
                conclusion:
                  step.conclusion ?? (step.status === "in_progress" ? "running" : "queued"),
              },
            ]),
          )
        : (job.result?.steps ?? {}),
    })),
  };
}
