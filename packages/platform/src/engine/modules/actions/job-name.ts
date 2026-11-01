import type { ActionWorkflowPlan } from "@repo/core";
import type { ActionJob } from "@repo/db";

/** Jobs skipped before expansion have no spec; retain their declared name. */
export function actionJobName(
  plan: ActionWorkflowPlan,
  job: Pick<ActionJob, "jobKey" | "spec">,
): string {
  if (job.spec?.name) return job.spec.name;
  const name = plan.jobs.find((definition) => definition.id === job.jobKey)?.name;
  // A skipped matrix has no concrete values with which to resolve its name.
  return name && !name.includes("${{") ? name : job.jobKey;
}
