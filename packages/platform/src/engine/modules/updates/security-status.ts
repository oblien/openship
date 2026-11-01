import { isMutableImageRef, matchSecurityAdvisories } from "@repo/core";
import type { ProjectSecurityResult } from "@repo/contracts";
import type { AdvisoryFeedState } from "./advisory-feed";
import type { SecurityInventory } from "./security-inventory";

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
        canRefresh:
          !upstream.stale &&
          match.advisory.action === "refresh-images" &&
          (!match.image || isMutableImageRef(match.image.ref)),
      });
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
