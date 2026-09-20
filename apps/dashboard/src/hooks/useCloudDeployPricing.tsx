"use client";

import { useCallback, useEffect, useRef } from "react";
import { useModal } from "@/context/ModalContext";
import { CloudDeployPlanModal } from "@/components/billing/CloudDeployPlanModal";
import { cloudDeployRestriction } from "@/lib/cloud-deploy-pricing";

/** Call from an explicit Deploy/Start/Redeploy catch, never from configuration
 * effects or Save. Reading billing first would incorrectly require billing:read
 * permission from every person who is otherwise allowed to deploy. */
export function useCloudDeployPricing() {
  const { showModal, hideModal } = useModal();
  const openModal = useRef<string | null>(null);

  useEffect(() => () => {
    if (openModal.current) hideModal(openModal.current);
    openModal.current = null;
  }, [hideModal]);

  return useCallback((error: unknown): boolean => {
    const restriction = cloudDeployRestriction(error);
    if (!restriction) return false;
    if (openModal.current) return true;
    const id = showModal({
      customContent: <CloudDeployPlanModal restriction={restriction} onClose={() => hideModal(id)} />,
      width: "100%",
      maxWidth: "1160px",
      showCloseButton: false,
      onClose: () => { openModal.current = null; },
    });
    openModal.current = id;
    return true;
  }, [showModal, hideModal]);
}
