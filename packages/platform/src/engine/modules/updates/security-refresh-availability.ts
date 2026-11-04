import { ValidationError, type SecurityImageEvidence } from "@repo/core";
import { resolveLatestImageDigest } from "../../lib/image-registry";
import { reportCaughtError } from "@repo/core/diagnostics";
import type { ProjectSecurityResult } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { planProjectRuntimeUpdate, RuntimeSourceRedeployRequired } from "./runtime-update";

/** Use the deployment preflight before presenting an actionable security refresh. */
export async function annotateSecurityRefreshAvailability(
  ctx: ExecutionContext,
  result: ProjectSecurityResult,
  images: readonly SecurityImageEvidence[] = [],
  refresh = false,
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
      // A prebuilt image cannot acquire a patched interpreter by restarting the
      // exact same artifact. Never advertise that no-op as security remediation.
      const image = images.find((i) => i.serviceId === finding.serviceId && i.role === "image");
      if (image?.digest) {
        const latest = await resolveLatestImageDigest(image.ref, { refresh });
        if (!latest)
          throw new ValidationError(
            "The registry could not confirm a replacement image. Check again before updating.",
          );
        if (latest === image.digest) {
          finding.imageChangeRequired = true;
          throw new ValidationError(
            `The configured image (${image.ref}) has not changed and still contains the affected runtime. Choose a patched image version in configuration, then redeploy. Refreshing this image again will not fix the advisory.`,
          );
        }
      }
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
