"use client";

import type { CloudCapability } from "@repo/core";
import { useI18n, interpolate } from "@/components/i18n-provider";

/**
 * The prompt copy shown in the "Connect Openship Cloud" modal. Owned here (not
 * in CloudContext) so the context consumes it and the copy stays keyed off the
 * shared capability registry — no free-form strings at call sites.
 */
export interface CloudRequirementPrompt {
  feature: string;
  description?: string;
  secondaryHint?: string;
  ctaLabel?: string;
}

/**
 * Resolve a capability → localized connect-modal prompt. The four capabilities
 * that flow through `requireCloud` map to existing i18n; billing/migrate/pages
 * are driven by their own dedicated UIs, not this hook, so they get a safe
 * generic fallback if ever passed here.
 */
export function useCloudCapabilityCopy() {
  const { t } = useI18n();
  return (capability: CloudCapability, vars?: { domain?: string }): CloudRequirementPrompt => {
    const domain = vars?.domain ?? "";
    const s = t.deploy.sidebar;
    switch (capability) {
      case "managed-project-domain":
        return {
          feature: interpolate(s.freeDomainFeature, { domain }),
          description: interpolate(s.freeDomainDesc, { domain }),
          secondaryHint: s.freeDomainHint,
        };
      case "managed-compose-domains":
        return {
          feature: interpolate(s.servicesFreeDomainFeature, { domain }),
          description: interpolate(s.servicesFreeDomainDesc, { domain }),
          secondaryHint: s.servicesFreeDomainHint,
        };
      case "cloud-services-catalog":
        return {
          feature: t.projectDetail.services.addModal.cloudConnectTitle,
          description: t.projectDetail.services.addModal.cloudConnectBody,
        };
      case "cloud-deploy-target":
      default:
        return { feature: t.deploy.targetStep.requireCloudFeature };
    }
  };
}
