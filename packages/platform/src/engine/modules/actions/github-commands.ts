import { createHash } from "node:crypto";
import { AppError, ValidationError, generateId, safeErrorMessage } from "@repo/core";
import { repos, type ActionRun, type ActionWorkflow } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import type { ActionTrigger } from "./action.service";
import { GitHubActionsApi } from "./github-api";
import { synchronizeGitHubRun } from "./github-sync";
import { diagnostics } from "@repo/core/diagnostics";

/** GitHub dispatch/rerun POSTs have no idempotency key. Persist the intent BEFORE
 * sending one; an uncertain response is reconciled, never silently replayed. */
async function submitCommand(
  ctx: ExecutionContext,
  workflow: ActionWorkflow,
  key: string,
  payload: Record<string, unknown>,
  submit: (api: GitHubActionsApi) => Promise<{ id: string; attempt: number }>,
  sourceJob?: ActionTrigger["sourceJob"],
): Promise<ActionRun> {
  const api = new GitHubActionsApi(ctx, workflow.owner!, workflow.repo!);
  const receipt = await repos.actions.beginGitHubCommand({
    id: generateId("acmd"),
    organizationId: ctx.organizationId,
    workflowId: workflow.id,
    idempotencyKey: `${workflow.id}:${key}`,
    requestHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    sourceJob,
  });
  let remoteId = receipt.command.remoteRunId;
  let attempt = receipt.command.remoteAttempt;
  if (receipt.submit) {
    try {
      const result = await submit(api);
      remoteId = result.id;
      attempt = result.attempt;
      await repos.actions.finishGitHubCommand(ctx.organizationId, receipt.command.id, {
        state: "accepted",
        remoteRunId: remoteId,
        remoteAttempt: attempt,
        error: null,
      });
    } catch (error) {
      // A timeout/5xx may have committed at GitHub. The original request stays
      // visible in history and must not be submitted a second time by a retry.
      const status = Number(
        (error as { statusCode?: number; status?: number })?.statusCode ??
          (error as { status?: number })?.status ??
          0,
      );
      const rejected = [400, 401, 403, 404, 409, 422].includes(status);
      await repos.actions.finishGitHubCommand(ctx.organizationId, receipt.command.id, {
        state: rejected ? "rejected" : "uncertain",
        remoteRunId: remoteId,
        remoteAttempt: attempt,
        error: safeErrorMessage(error),
      });
      await repos.actions.requestGitHubSync(ctx.organizationId, workflow.id);
      if (rejected) throw error;
      throw new AppError(
        "GitHub may have accepted this request. Refresh Runs or check GitHub before starting another run; this request will not be sent twice.",
        503,
        "ACTIONS_GITHUB_COMMAND_UNCERTAIN",
      );
    }
  }
  if (!remoteId || !attempt) {
    if (receipt.command.state === "rejected")
      throw new AppError(
        receipt.command.error ?? "GitHub rejected the request",
        409,
        "ACTIONS_GITHUB_COMMAND_REJECTED",
      );
    throw new AppError(
      "This request is being reconciled with GitHub. Refresh Runs before starting another run.",
      409,
      "ACTIONS_GITHUB_COMMAND_PENDING",
    );
  }
  await repos.actions.requestGitHubSync(ctx.organizationId, workflow.id);
  try {
    return await synchronizeGitHubRun(ctx, workflow, await api.attempt(remoteId, attempt), api);
  } catch (error) {
    diagnostics.warn(
      "actions/github-command",
      "Accepted GitHub command is waiting for synchronization",
      error,
      { workflowId: workflow.id, runId: remoteId },
    );
    throw new AppError(
      "GitHub accepted the request. Its run will appear after synchronization; do not submit it again.",
      503,
      "ACTIONS_GITHUB_SYNC_PENDING",
    );
  }
}

export async function dispatchGitHubWorkflow(
  ctx: ExecutionContext,
  workflow: ActionWorkflow,
  trigger: ActionTrigger,
) {
  if (!workflow.enabled)
    throw new AppError("This workflow is disabled", 409, "ACTIONS_WORKFLOW_DISABLED");
  if (trigger.eventName !== "workflow_dispatch")
    throw new ValidationError(
      "GitHub controls this workflow's automatic events. Send repository events to GitHub, or use Run workflow for a manual run.",
    );
  const ref = trigger.ref ?? workflow.ref;
  const inputs = Object.fromEntries(
    Object.entries(trigger.inputs ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  );
  return submitCommand(
    ctx,
    workflow,
    `dispatch:${trigger.key}`,
    { ref, inputs, sourceJob: trigger.sourceJob },
    async (api) => {
      const result = await api.dispatch(workflow.githubWorkflowId!, ref, inputs);
      return { id: String(result.workflow_run_id), attempt: 1 };
    },
    trigger.sourceJob,
  );
}

export async function rerunGitHubWorkflow(ctx: ExecutionContext, run: ActionRun, key: string) {
  const workflow = await repos.actions.workflow(ctx.organizationId, run.workflowId);
  if (!workflow || workflow.controller !== "github" || !run.github)
    throw new AppError("GitHub workflow connection changed", 409, "ACTIONS_WORKFLOW_CHANGED");
  if (!workflow.enabled)
    throw new AppError("This workflow is disabled", 409, "ACTIONS_WORKFLOW_DISABLED");
  return submitCommand(
    ctx,
    workflow,
    `rerun:${key}`,
    { runId: run.github.id, attempt: run.attempt },
    async (api) => {
      const current = await api.run(run.github!.id);
      if (current.run_attempt !== run.attempt || current.status !== "completed")
        throw new AppError(
          "This run has already been retried or is still running. Refresh its history.",
          409,
          "ACTIONS_RUN_ACTIVE",
        );
      await api.rerun(run.github!.id);
      return { id: run.github!.id, attempt: run.attempt + 1 };
    },
    run.configuration.sourceJob,
  );
}

export async function controlGitHubRun(
  ctx: ExecutionContext,
  run: ActionRun,
  action: "cancel" | "approve",
) {
  if (!run.github || !run.configuration.owner || !run.configuration.repo)
    throw new Error("Invalid GitHub run");
  const api = new GitHubActionsApi(ctx, run.configuration.owner, run.configuration.repo);
  // Never cancel a newer attempt when an old run screen is still open.
  const current = await api.run(run.github.id);
  if (current.run_attempt !== run.attempt)
    throw new AppError(
      "A newer attempt exists. Open that run before changing it.",
      409,
      "ACTIONS_RUN_CHANGED",
    );
  if (action === "cancel") {
    if (current.status !== "completed") await api.cancel(run.github.id);
    await repos.actions.requestGitHubCancel(ctx.organizationId, run.id);
  } else await api.approve(run.github.id);
  await repos.actions.requestGitHubSync(ctx.organizationId, run.workflowId);
}
