import { actionRunnerAdmissionKey } from "@repo/core";
import type { actionRun, actionRunner, actionWorkflow } from "../schema/actions";

/** Call while holding the workflow row lock at each new-execution boundary.
 * Already running workers still need reconciliation and cleanup after revocation. */
export function actionRunAdmitted(
  workflow: typeof actionWorkflow.$inferSelect | undefined,
  run: typeof actionRun.$inferSelect,
) {
  if (!workflow?.enabled || run.cancelRequestedAt || run.finishedAt) return false;
  // Independent workflows saved before access policies retain their original
  // fork approval rule. Every newly saved workflow has an explicit policy.
  if (run.controller === "openship" && !workflow.accessPolicy)
    return !run.untrusted || !!run.approvedAt;
  return (
    run.admission?.state === "allowed" &&
    run.admission.workflowVersion === workflow.updatedAt.toISOString()
  );
}

export function actionRunnerAdmitted(
  workflow: typeof actionWorkflow.$inferSelect | undefined,
  run: typeof actionRun.$inferSelect,
  runner: typeof actionRunner.$inferSelect,
) {
  return (
    actionRunAdmitted(workflow, run) &&
    runner.enabled &&
    workflow!.runnerIds.includes(runner.id) &&
    (!run.untrusted || !!runner.cloudPoolId) &&
    (run.controller === "github" || run.configuration.runnerIds.includes(runner.id)) &&
    ((run.controller === "openship" && !workflow!.accessPolicy) ||
      run.admission?.runnerKeys?.[runner.id] === actionRunnerAdmissionKey(runner))
  );
}
