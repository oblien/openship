"use client";

import { useEffect, useRef } from "react";
import { SYSTEM, isDeploymentResourceIssue } from "@repo/core";
import { Icon as UiIcon } from "@repo/ui/icons";
import { useDeployment } from "@/context/DeploymentContext";
import { BUILD_PHASES } from "@/context/deployment/types";
import { useBuildElapsedMs } from "@/context/deployment/useBuildElapsedMs";
import { useModal } from "@/context/ModalContext";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { ServerCapacityRecovery } from "@/components/servers/managed/ServerCapacityRecovery";
import { cloudDeployCapacityFailure } from "@/lib/cloud-deploy-pricing";
import { DeploymentConfigurationAction } from "./DeploymentActions";

/** Both deployment views use the saved diagnosis. No billing or host request is
 * made until the user opens capacity review; the existing build clock is local. */
export function CloudDeploymentResourceNotice() {
  const { config } = useDeployment();
  return config.deployTarget === "cloud" ? <ResourceNotice /> : null;
}

function ResourceNotice() {
  const { config, state, deploymentStatus } = useDeployment();
  const { showModal, hideModal } = useModal();
  const { t } = useI18n();
  const copy = t.deployments.resourceGuidance;
  const elapsed = useBuildElapsedMs(state);
  const modal = useRef<string | null>(null);
  const savedIssue = state.errorDetails?.resourceIssue;
  const terminal = deploymentStatus === "failed" || deploymentStatus === "ready";
  const capacityRefusal = terminal && cloudDeployCapacityFailure(state);
  const issue = terminal && isDeploymentResourceIssue(savedIssue) ? savedIssue : null;
  const phase = BUILD_PHASES[state.currentStepIndex]?.id;
  const slow =
    !issue &&
    !capacityRefusal &&
    deploymentStatus === "building" &&
    state.isDeploying &&
    !state.queue &&
    !state.pendingPrompt &&
    !state.cancellationPending &&
    (phase === "install" || phase === "build") &&
    elapsed !== null &&
    elapsed >= SYSTEM.DEPLOYMENTS.SLOW_BUILD_NOTICE_MS;
  const projectId = state.projectId || config.projectId;
  // The persisted binding belongs to this attempt. A later project retarget must
  // not send an old deployment's upgrade action to a different Cloud space.
  const workspaceId =
    issue || capacityRefusal
      ? typeof state.errorDetails?.workspaceId === "string"
        ? state.errorDetails.workspaceId
        : undefined
      : config.workspaceId;

  useEffect(
    () => () => {
      if (modal.current) hideModal(modal.current);
      modal.current = null;
    },
    [hideModal, state.deploymentId, workspaceId],
  );

  if ((!issue && !capacityRefusal && !slow) || !state.deploymentId || state.deploymentCanceled)
    return null;
  const description = issue
    ? copy.causes[issue]
    : capacityRefusal
      ? t.billing.workspaces.buildCapacityHint
      : copy.slowDescription;
  const canReview =
    !!workspaceId && !!projectId && issue !== "process-heap" && issue !== "process-killed";

  function reviewCapacity() {
    if (!workspaceId || modal.current) return;
    const id = showModal({
      customContent: (
        <ServerCapacityRecovery
          workspaceId={workspaceId}
          message={description}
          advisory
          onClose={() => hideModal(id)}
        />
      ),
      width: "100%",
      maxWidth: "880px",
      maxHeight: "calc(100dvh - 2rem)",
      overflow: "hidden",
      showCloseButton: false,
      onClose: () => {
        if (modal.current === id) modal.current = null;
      },
    });
    modal.current = id;
  }

  return (
    <section aria-label={copy.label} className="rounded-2xl bg-card p-5">
      <div className="flex items-start gap-3" role="status">
        <UiIcon
          name={issue || capacityRefusal ? "warning" : "clock"}
          aria-hidden
          className={`mt-0.5 size-4 shrink-0 ${issue || capacityRefusal ? "text-warning" : "text-muted-foreground"}`}
        />
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">
            {issue
              ? copy.titles[issue]
              : capacityRefusal
                ? t.billing.workspaces.buildCapacityTitle
                : copy.slowTitle}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canReview && (
          <Button variant="secondary" size="sm" onClick={reviewCapacity}>
            {copy.reviewCapacity}
          </Button>
        )}
        {projectId && <DeploymentConfigurationAction className="text-sm" />}
      </div>
    </section>
  );
}
