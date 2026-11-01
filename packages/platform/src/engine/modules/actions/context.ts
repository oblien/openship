import type { ActionNeedsResult } from "@repo/core";
import type { ActionRun } from "@repo/db";
import type { ActionExpressionContext } from "./expressions";

export function actionContext(
  run: ActionRun,
  needs: Record<string, ActionNeedsResult> = {},
): ActionExpressionContext {
  return {
    github: {
      ...run.event,
      event: run.event,
      event_name: run.eventName,
      repository: run.configuration.owner
        ? `${run.configuration.owner}/${run.configuration.repo}`
        : "",
      repository_owner: run.configuration.owner ?? "",
      ref: run.ref,
      sha: run.revision,
      actor: run.actor,
      workflow: run.configuration.workflows?.root?.plan.name ?? run.plan.name,
      run_id: run.id,
      run_number: run.number,
      run_attempt: run.attempt,
      ref_name: run.ref.replace(/^refs\/(heads|tags)\//, ""),
      ref_type: run.ref.startsWith("refs/tags/") ? "tag" : "branch",
    },
    inputs: run.inputs,
    vars: run.configuration.variables,
    needs,
    cancelled: !!run.cancelRequestedAt,
  };
}
