import { isMutableImageRef, matchSecurityAdvisories } from "@repo/core";
import type { ProjectSecurityResult } from "@repo/contracts";
import type { AdvisoryFeedState } from "./advisory-feed";
import type { SecurityInventory } from "./security-inventory";

export const RUNTIME_UPGRADE_REQUIRED_MESSAGE =
  "This advisory requires a newer runtime major version. Update the configured image or Dockerfile, then redeploy. Refreshing images preserves the configured version.";

/** The same matcher/result for the global banner, explicit inspection and scheduler. */
export function buildProjectSecurityResult(
  projectId: string,
  inventory: SecurityInventory,
  upstream: AdvisoryFeedState,
  autoRefresh: boolean,
  services: ReadonlyMap<string, string>,
): ProjectSecurityResult {
  const matched = upstream.security
    ? matchSecurityAdvisories(upstream.security, inventory.images, inventory.runtimes)
    : [];
  const findings = new Map<string, ProjectSecurityResult["findings"][number]>();
  for (const match of matched) {
    const id = JSON.stringify([match.advisory.id, match.serviceId]);
    const previous = findings.get(id);
    if (previous) {
      previous.evidence.push(match.evidence);
      if (match.confidence === "confirmed") previous.confidence = "confirmed";
    } else
      findings.set(id, {
        id: match.advisory.id,
        revision: match.advisory.revision,
        title: match.advisory.title,
        message: match.advisory.message,
        severity: match.advisory.severity,
        url: match.advisory.url,
        serviceId: match.serviceId,
        serviceName: match.serviceId ? (services.get(match.serviceId) ?? null) : null,
        evidence: [match.evidence],
        confidence: match.confidence,
        ...(match.advisory.action === "manual" ? { manualReviewRequired: true } : {}),
        canRefresh:
          !upstream.stale &&
          !inventory.unknownServices.includes(match.serviceId) &&
          match.advisory.action === "refresh-images" &&
          (!match.image || isMutableImageRef(match.image.ref)),
      });
    if (match.runtimeUpgradeRequired) {
      const finding = findings.get(id)!;
      finding.canRefresh = false;
      finding.runtimeUpgradeRequired = true;
      finding.refreshBlockedReason = RUNTIME_UPGRADE_REQUIRED_MESSAGE;
    }
  }
  return {
    projectId,
    deploymentId: inventory.deploymentId,
    checkedAt: inventory.checkedAt,
    autoRefresh,
    feedStale: upstream.stale,
    feedError: upstream.error,
    unknownServices: inventory.unknownServices,
    findings: [...findings.values()],
  };
}
