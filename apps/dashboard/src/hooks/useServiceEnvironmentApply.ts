"use client";

import { useCallback, useRef, useState } from "react";
import { useI18n } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import { getApiErrorMessage } from "@/lib/api/client";
import { servicesApi } from "@/lib/api/services";
import { invalidateProjectCaches } from "@/hooks/useProjectEndpoints";
import { useCloudDeployPricing } from "@/hooks/useCloudDeployPricing";

type ServiceTarget = { id: string; name: string };

/** A service action: keep the editor open and report actual completion. */
export function useServiceEnvironmentApply(projectId: string, onApplied: () => void | Promise<void>) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const showCloudPricing = useCloudDeployPricing();
  const copy = t.projectDetail.services.detail.environmentApply;
  const [applyingServiceId, setApplyingServiceId] = useState<string | null>(null);
  const pending = useRef(false);

  const apply = useCallback(async (service: ServiceTarget) => {
    if (pending.current) return;
    pending.current = true;
    setApplyingServiceId(service.id);
    try {
      const response = await servicesApi.applyEnvironment(projectId, service.id);
      if (!response?.success || !response.containerId) {
        throw new Error(copy.failed);
      }
      invalidateProjectCaches(projectId);
      showToast(response.warning || copy.applied, response.warning ? "info" : "success", service.name);
      // The apply has already succeeded. A refresh failure must not relabel it
      // as a failed mutation or cause another container replacement.
      await Promise.resolve().then(onApplied).catch(() => {});
    } catch (error) {
      if (!showCloudPricing(error)) {
        showToast(getApiErrorMessage(error, copy.failed), "error", service.name);
      }
    } finally {
      pending.current = false;
      setApplyingServiceId(null);
    }
  }, [projectId, onApplied, showCloudPricing, showToast, copy.failed, copy.applied]);

  return { apply, applyingServiceId };
}
