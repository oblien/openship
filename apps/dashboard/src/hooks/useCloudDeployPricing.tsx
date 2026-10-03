"use client";

import { useCallback, useEffect, useRef } from "react";
import { useModal } from "@/context/ModalContext";
import { CloudDeployPlanModal } from "@/components/billing/CloudDeployPlanModal";
import { cloudDeployRestriction, cloudCapacityRestriction } from "@/lib/cloud-deploy-pricing";
import { ApiError } from "@/lib/api/client";
import { ServerCapacityRecovery } from "@/components/servers/managed/ServerCapacityRecovery";

/** Call from an explicit Deploy/Start/Redeploy catch, never from configuration
 * effects or Save. Reading billing first would incorrectly require billing:read
 * permission from every person who is otherwise allowed to deploy. */
export function useCloudDeployPricing(selectedWorkspaceId?: string | null) {
  const { showModal, hideModal } = useModal();
  const openModal = useRef<string | null>(null);

  useEffect(() => () => {
    if (openModal.current) hideModal(openModal.current);
    openModal.current = null;
  }, [hideModal]);

  return useCallback((error: unknown, onRetry?: () => Promise<unknown>): boolean => {
    const restriction = cloudDeployRestriction(error);
    const capacity = cloudCapacityRestriction(error);
    const body = error instanceof ApiError ? error.body as { workspaceId?: unknown; code?: unknown; error?: unknown } | null : null;
    const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId : selectedWorkspaceId ?? undefined;
    const workspaceCapacity = workspaceId && body?.code === "CLOUD_WORKSPACE_BUILD_CAPACITY";
    if (!restriction && !capacity && !workspaceCapacity) return false;
    if (openModal.current) return true;
    const retry = onRetry ? async () => {
      const result = await onRetry();
      openModal.current = null;
      hideModal(id);
      return result;
    } : undefined;
    const id = showModal({
      customContent: capacity || workspaceCapacity
        ? <ServerCapacityRecovery workspaceId={workspaceId} message={typeof body?.error === "string" ? body.error : undefined} onClose={() => hideModal(id)} onRetry={retry} />
        : <CloudDeployPlanModal workspaceId={workspaceId} restriction={restriction!} onClose={() => hideModal(id)} />,
      width: "100%",
      maxWidth: capacity ? "880px" : "1440px",
      maxHeight: "calc(100dvh - 2rem)",
      overflow: "hidden",
      showCloseButton: false,
      onClose: () => { if (openModal.current === id) openModal.current = null; },
    });
    openModal.current = id;
    return true;
  }, [showModal, hideModal, selectedWorkspaceId]);
}
