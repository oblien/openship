import { ValidationError, type SecurityAdvisory } from "@repo/core";
import { resolveLatestImageDigest } from "../../lib/image-registry";
import { reportCaughtError } from "@repo/core/diagnostics";
import type { ProjectSecurityResult } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { planProjectRuntimeUpdate, RuntimeSourceRedeployRequired } from "./runtime-update";
import type { SecurityInventory } from "./security-inventory";
import { planSecurityRuntimePatch, RuntimeImageChangeRequired } from "./security-runtime-patch";

/** Use the deployment preflight before presenting an actionable security refresh. */
export async function annotateSecurityRefreshAvailability(
  ctx: ExecutionContext,
  result: ProjectSecurityResult,
  inventory: SecurityInventory | undefined,
  advisories: readonly SecurityAdvisory[],
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
      const advisory = advisories.find((item) => item.id === finding.id);
      if (inventory && advisory) {
        const patch = await planSecurityRuntimePatch(
          ctx,
          result.projectId,
          finding.serviceId,
          advisory,
          inventory,
          refresh,
        );
        if (patch) {
          finding.runtimePatch = patch;
          continue;
        }
      }
      // A prebuilt image cannot acquire a patched interpreter by restarting the
      // exact same artifact. Never advertise that no-op as security remediation.
      const image = inventory?.images.find(
        (i) => i.serviceId === finding.serviceId && i.role === "image",
      );
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
        if (error instanceof RuntimeImageChangeRequired) finding.imageChangeRequired = true;
      } else {
        reportCaughtError(error, "updates/security-refresh-availability");
        finding.refreshBlockedReason =
          "Runtime refresh eligibility could not be confirmed. Check again before updating.";
      }
    }
  }
}
