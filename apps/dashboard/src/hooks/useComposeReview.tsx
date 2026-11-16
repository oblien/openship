"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useModal } from "@/context/ModalContext";
import { useCloudResourceKey } from "@/context/CloudResourceContext";
import { getApiRequestScopeVersion } from "@/lib/api/client";
import { ComposeReviewDialog, composeReviewDetails } from "@/components/deploy/ComposeReviewDialog";
import { encodeProjectSlug } from "@/utils/repoSlug";

export { ComposeChangeSummary } from "@/components/deploy/ComposeReviewDialog";
export type { ComposeChanges } from "@repo/contracts";

/** Review presentation only: each caller retries its original deployment operation. */
export function useComposeReview(projectId?: string | null) {
  const { showModal, hideModal } = useModal();
  const router = useRouter();
  const resourceKey = useCloudResourceKey();
  const openModal = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (openModal.current) hideModal(openModal.current);
      openModal.current = null;
    },
    [projectId, resourceKey, hideModal],
  );
  return useCallback(
    (error: unknown, onApply?: (revision: string) => Promise<unknown>): boolean => {
      const review = composeReviewDetails(error);
      if (!review) return false;
      const id = projectId || review.projectId;
      if (!id || (review.projectId && review.projectId !== id)) return false;
      if (openModal.current) return true;
      const scope = getApiRequestScopeVersion();
      const current = () => openModal.current === modalId && scope === getApiRequestScopeVersion();
      const close = () => {
        if (openModal.current === modalId) {
          openModal.current = null;
          hideModal(modalId);
        }
      };
      const modalId = showModal({
        customContent: (
          <ComposeReviewDialog
            review={{ ...review, projectId: id }}
            onClose={close}
            onApply={
              onApply
                ? async (revision) => {
                    if (!current()) {
                      close();
                      return;
                    }
                    return onApply(revision);
                  }
                : undefined
            }
            onConfigure={() => {
              if (!current()) {
                close();
                return;
              }
              close();
              const url = `/deploy/${encodeProjectSlug(id)}?reviewCompose=1`;
              if (window.location.pathname === url.split("?")[0]) window.location.assign(url);
              else router.push(url);
            }}
          />
        ),
        width: "920px",
        maxWidth: "calc(100vw - 2rem)",
        maxHeight: "calc(100dvh - 2rem)",
        overflow: "hidden",
        showCloseButton: false,
        closable: false,
        onClose: () => {
          if (openModal.current === modalId) openModal.current = null;
        },
      });
      openModal.current = modalId;
      return true;
    },
    [projectId, resourceKey, showModal, hideModal, router],
  );
}
