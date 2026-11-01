"use client";

import { useEffect, useRef } from "react";
import type { CloudBuildQueueStatus } from "@/context/deployment/types";
import { useModal } from "@/context/ModalContext";
import { CloudDeployPlanModal } from "@/components/billing/CloudDeployPlanModal";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";

/** Only mounted for a Cloud queue snapshot; billing is fetched on click only. */
export function CloudBuildQueueNotice({ queue }: { queue: CloudBuildQueueStatus }) {
  const { showModal, hideModal } = useModal();
  const { t, locale } = useI18n();
  const copy = t.deployments.cloudBuildQueue;
  const number = new Intl.NumberFormat(locale);
  const modal = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (modal.current) hideModal(modal.current);
    },
    [hideModal],
  );

  const reason = copy[queue.reason];
  const canComparePlans =
    queue.reason === "resources" ||
    (queue.reason === "concurrency" && queue.simultaneousBuilds !== null);

  function viewPlans() {
    if (modal.current) return;
    const id = showModal({
      customContent: (
        <CloudDeployPlanModal
          workspaceId={queue.workspaceId}
          restriction={{
            code: "PLAN_UPGRADE_REQUIRED",
            reason: queue.reason === "resources" ? "resource-tier" : "build-concurrency",
            message: queue.reason === "resources" ? copy.compareResources : copy.compareConcurrency,
          }}
          onClose={() => hideModal(id)}
        />
      ),
      width: "100%",
      maxWidth: "1440px",
      maxHeight: "calc(100dvh - 2rem)",
      overflow: "hidden",
      showCloseButton: false,
      onClose: () => {
        modal.current = null;
      },
    });
    modal.current = id;
  }

  return (
    <section className="rounded-2xl bg-card p-5" aria-label={copy.label}>
      <div role="status" aria-live="polite">
        <p className="text-sm font-medium text-foreground">
          {queue.position === null
            ? copy.title
            : interpolate(copy.position, { position: number.format(queue.position) })}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {reason} {copy.automaticStart}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {queue.simultaneousBuilds === null
            ? copy.unlimited
            : interpolate(copy.allowance, { count: number.format(queue.simultaneousBuilds) })}{" "}
          {interpolate(copy.active, { count: number.format(queue.activeBuilds) })}
        </p>
      </div>
      {canComparePlans && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="sm" onClick={viewPlans}>
            {copy.comparePlans}
          </Button>
          <span className="text-xs text-muted-foreground">{copy.optionalUpgrade}</span>
        </div>
      )}
    </section>
  );
}
