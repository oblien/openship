import { ValidationError } from "@repo/core";
import { reportCaughtError } from "@repo/core/diagnostics";
import type { ProjectSecurityResult } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { planProjectRuntimeUpdate, RuntimeSourceRedeployRequired } from "./runtime-update";

/** Use the deployment preflight before presenting an actionable security refresh. */
export async function annotateSecurityRefreshAvailability(
  ctx: ExecutionContext,
  result: ProjectSecurityResult,
): Promise<void> {
  const scopes = new Map<string | null, Promise<void>>();
  for (const finding of result.findings) {
    if (!finding.canRefresh) continue;
    let check = scopes.get(finding.serviceId);
    if (!check) {
      check = planProjectRuntimeUpdate(
        ctx,
        result.projectId,
        finding.serviceId ? { serviceIds: [finding.serviceId] } : {},
      ).then((plan) => {
        if (plan.deploymentId !== result.deploymentId)
          throw new ValidationError("The active deployment changed. Check the advisory again.");
      });
      scopes.set(finding.serviceId, check);
    }
    try {
      await check;
    } catch (error) {
      finding.canRefresh = false;
      if (error instanceof ValidationError) {
        finding.refreshBlockedReason = error.message;
        if (error instanceof RuntimeSourceRedeployRequired) finding.sourceRedeployRequired = true;
      } else {
        reportCaughtError(error, "updates/security-refresh-availability");
        finding.refreshBlockedReason =
          "Runtime refresh eligibility could not be confirmed. Check again before updating.";
      }
    }
  }
}
