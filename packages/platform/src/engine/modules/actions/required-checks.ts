import { ValidationError, type ActionWorkflowPlan } from "@repo/core";
import { matchesActionFilters } from "./trigger-pattern";
import { record } from "./workflow";

/** Required checks must always cover their deployment branch. Optional CI may filter paths. */
export function assertRequiredPushWorkflow(
  plan: ActionWorkflowPlan,
  branch: string,
  name = plan.name,
) {
  if (!("push" in plan.triggers))
    throw new ValidationError(`${name} must declare a push trigger to gate deployments`);
  const filters = record(plan.triggers.push);
  if (filters.paths !== undefined || filters["paths-ignore"] !== undefined)
    throw new ValidationError(
      `${name} has a path filter. Required deployment checks must run on every push to the project branch; keep this workflow optional or remove the filter.`,
    );
  if (
    (filters.tags !== undefined && filters.branches === undefined) ||
    !matchesActionFilters(filters.branches, [branch]) ||
    !matchesActionFilters(filters["branches-ignore"], [branch], true)
  )
    throw new ValidationError(`${name} does not run on the project's ${branch} branch`);
}
