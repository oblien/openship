"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React from "react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { DeploymentsContent } from "@/app/(dashboard)/deployments/components";
import { deployApi, projectsApi, isAbortError, getApiErrorMessage } from "@/lib/api";
import type { PendingAction } from "@/lib/api/projects";
import { updatesApi } from "@/lib/api/updates";
import { openTriggeredBuild } from "@/lib/deploy-nav";
import { useModal } from "@/context/ModalContext";
import { useCloudDeployPricing } from "@/hooks/useCloudDeployPricing";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useRouter } from "next/navigation";
import DropdownMenu from "@/components/ui/DropdownMenu";
import WarningCallout from "@/components/shared/WarningCallout";
import {
  hasConnectedDomain,
  isPotentiallyPublicService,
  shouldWarnAboutUnreachableServices,
} from "./redeploy-unreachable-warning";
export const Deployments = () => {
  const {
    id,
    projectData,
    setActiveTab,
    servicesData,
    refreshServices,
    hasMultipleServices,
    domainsData,
    availableUpdate,
    refreshUpdateStatus,
  } = useProjectSettings();
  const { t } = useI18n();
  const { showToast } = useToast();
  const showCloudPricing = useCloudDeployPricing(projectData.workspaceId);
  const { showModal, hideModal } = useModal();
  const router = useRouter();

  const [isRedeploying, setIsRedeploying] = React.useState(false);
  // The Openship control-plane self-app has no deployable source and updates
  // itself via the CLI — redeploy/self-update controls would only 403, so hide them.
  const isSelfApp = projectData?.appTemplateId === "openship";

  React.useEffect(() => { void refreshUpdateStatus(); }, [refreshUpdateStatus]);

  /**
   * A deploy blocked on something the operator can clear — today a port already
   * in use. Fetched only when the project payload says there IS one
   * (`latestDeploymentBlocked`), so the common case costs no request.
   *
   * This is the gap this banner fills: a blocked deploy fails, and a failed
   * deploy never becomes the active one, so every other flag on this page (all
   * derived from the ACTIVE deployment) is structurally unable to mention it.
   */
  const [blockedAction, setBlockedAction] = React.useState<PendingAction | null>(null);
  const isBlocked = !!projectData?.latestDeploymentBlocked;

  React.useEffect(() => {
    if (!projectData?.id || !isBlocked) {
      setBlockedAction(null);
      return;
    }
    let cancelled = false;
    projectsApi
      .getPendingActions(projectData.id)
      .then((res) => {
        if (cancelled) return;
        setBlockedAction(res?.data?.actions?.find((a) => a.kind === "deploy_blocked") ?? null);
      })
      .catch(() => {
        /* best-effort — the status badge already says Action Required */
      });
    return () => {
      cancelled = true;
    };
  }, [projectData?.id, isBlocked, projectData?.latestDeploymentId]);

  /**
   * Redeploy = take the project's CURRENT saved configuration + env vars, pull
   * the latest commit, and create a new version. There is NO wizard and NO
   * reconfiguration here — config edits live in the Runtime tab. This is the
   * exact snapshot-current-config path the webhook uses (triggerDeployment), so
   * manual / webhook / single-entry redeploys all behave identically. We pass
   * forceAll because a manual redeploy has no changed-files signal to scope by,
   * so it rebuilds every service (a no-op for single-app projects). On success
   * we land on the build screen for the new version.
   */
  const runRedeploy = React.useCallback(
    async (mode: "smart" | "all" | "refresh" | "update" = "smart") => {
      if (!projectData?.id) return;
      setIsRedeploying(true); // drive the loading state for menu paths too
      try {
        if (mode === "update") {
          // Image updates must force-pull the tag through the existing update
          // operation; a normal rebuild can reuse the currently running image.
          const res = await updatesApi.apply(projectData.id);
          openTriggeredBuild(
            router,
            { data: { deployment: { id: res.data?.deployment_id } } },
            projectData.id,
          );
          return;
        }
        const body =
          mode === "all"
            ? { projectId: projectData.id, forceAll: true }
            : mode === "refresh"
              ? { projectId: projectData.id, refresh: true }
              : { projectId: projectData.id, smartRoute: true };
        const res = await deployApi.trigger(body);
        openTriggeredBuild(router, res, projectData.id);
      } catch (error) {
        if (showCloudPricing(error, () => runRedeploy(mode))) {
          setIsRedeploying(false);
          return;
        }
        // A timeout almost certainly means the server started the deploy but was
        // slow to return the id — show the deployments list so it's visible rather
        // than stranding the user on an error.
        if (isAbortError(error)) {
          showToast(
            t.projects.redeploy.deployStartedLong,
            "success",
            t.projects.redeploy.deployingTitle,
          );
          router.push(`/projects/${projectData.id}/deployments`);
          return;
        }
        console.error("Redeploy failed:", error);
        showToast(
          getApiErrorMessage(
            error,
            mode === "refresh"
              ? t.projects.redeploy.couldNotRefresh
              : t.projects.redeploy.couldNotRedeploy,
          ),
          "error",
          t.projects.redeploy.errorTitle,
        );
        setIsRedeploying(false); // success navigates away; only clear on failure
      }
    },
    [projectData?.id, router, showToast, showCloudPricing, t],
  );

  const handleRedeploy = async () => {
    if (!projectData?.id || isRedeploying) return;

    setIsRedeploying(true);
    try {
      if (hasMultipleServices) {
        const services =
          servicesData.services.length > 0 ? servicesData.services : await refreshServices();
        if (shouldWarnAboutUnreachableServices(services, domainsData.domains, projectData.port)) {
          const candidateServices = services.filter(
            (s) =>
              isPotentiallyPublicService(s) &&
              !hasConnectedDomain(s, domainsData.domains, projectData.port),
          );
          let modalId = "";
          modalId = showModal({
            customContent: (
              <div className="p-6">
                <WarningCallout
                  title={t.projects.redeploy.noPublicDomainTitle}
                  description={interpolate(
                    candidateServices.length === 1
                      ? t.projects.redeploy.noPublicDomainDescOne
                      : t.projects.redeploy.noPublicDomainDescOther,
                    { count: String(candidateServices.length) },
                  )}
                  actions={
                    <>
                      <button
                        type="button"
                        className="rounded-lg bg-foreground/[0.06] px-3 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1]"
                        onClick={() => {
                          hideModal(modalId);
                          setActiveTab("domains");
                        }}
                      >
                        {t.projects.redeploy.openDomains}
                      </button>
                      <button
                        type="button"
                        className="rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                        onClick={async () => {
                          hideModal(modalId);
                          await runRedeploy();
                        }}
                      >
                        {t.projects.redeploy.deployAnyway}
                      </button>
                    </>
                  }
                >
                  <div className="mt-3 rounded-xl border border-border/50 bg-background/40 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
                      {t.projects.redeploy.suggestedFix}
                    </p>
                    <ul className="mt-1.5 list-disc space-y-1 ps-5 text-[12px] text-muted-foreground">
                      <li>{t.projects.redeploy.fixStep1}</li>
                      <li>{t.projects.redeploy.fixStep2}</li>
                      <li>{t.projects.redeploy.fixStep3}</li>
                    </ul>
                  </div>
                </WarningCallout>
              </div>
            ),
            width: "560px",
            maxWidth: "92vw",
            showCloseButton: true,
          });
          return;
        }
      }

      await runRedeploy();
    } catch (error) {
      console.error("Error redeploying project:", error);
      showToast(t.projects.redeploy.failedRedeploy, "error", t.projects.redeploy.errorTitle);
    } finally {
      setIsRedeploying(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Blocked deploy — FIRST, because nothing shipped: the newest release
          didn't go out, whereas every other callout below is about a release that
          did. The copy and the button both come from the API item, so the reason
          (which process, which pid, whether it's a stale Openship deployment we
          can safely stop) is the server's answer rather than a guess here. */}
      {blockedAction && (
        <WarningCallout
          tone="danger"
          title={blockedAction.title}
          description={blockedAction.message}
          actions={
            <button
              type="button"
              onClick={() => void handleRedeploy()}
              disabled={isRedeploying}
              className="rounded-lg bg-danger-solid px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-danger-solid/90 disabled:opacity-60"
            >
              {isRedeploying ? t.projects.redeploy.deploying : t.projects.deployBlocked.redeploy}
            </button>
          }
        />
      )}

      {/* Routing-not-synced lives on Domains & Routes (RoutingUnsyncedCallout):
          the release itself shipped fine, so the fix belongs beside the routes. */}

      {/* Action-required nudge — the live release is a partial-failure deploy
          still awaiting a keep/reject decision. Links to the build screen where
          the decision (Keep / Retry / Reject) lives, so it stays reachable after
          navigating away. */}
      {projectData.awaitingDecision && projectData.activeDeploymentId && (
        <WarningCallout
          title={t.projects.redeploy.actionRequiredTitle}
          description={t.projects.redeploy.actionRequiredDescription}
          actions={
            <button
              type="button"
              onClick={() => router.push(`/build/${projectData.activeDeploymentId}`)}
              className="rounded-lg bg-warning-solid px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-warning-solid/90"
            >
              {t.projects.redeploy.reviewDeployment}
            </button>
          }
        />
      )}

      {/* "Project outdated" nudge — only when the deployed commit is behind the
          branch HEAD. Redeploy uses the same direct path as the button below. */}
      {!isSelfApp && availableUpdate?.mode === "commit" && (
        <WarningCallout
          title={t.projects.redeploy.newCommitTitle}
          description={
            <>
              <span className="font-mono text-foreground/80">
                {availableUpdate.latestSha?.slice(0, 7)}
              </span>
              {availableUpdate.latestMessage ? ` · ${availableUpdate.latestMessage}` : ""}{" "}
              {t.projects.redeploy.newCommitOn}{" "}
              <span className="font-mono text-foreground/80">{availableUpdate.branch}</span>
              {availableUpdate.deployedSha ? (
                <>
                  {" "}
                  {t.projects.redeploy.newCommitDeployedOn}{" "}
                  <span className="font-mono text-foreground/80">
                    {availableUpdate.deployedSha.slice(0, 7)}
                  </span>
                  .
                </>
              ) : (
                "."
              )}
            </>
          }
          actions={
            <button
              type="button"
              onClick={handleRedeploy}
              disabled={isRedeploying}
              className="rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
            >
              {isRedeploying ? t.projects.redeploy.deploying : t.projects.redeploy.redeployLatest}
            </button>
          }
        />
      )}

      {/* Release/dist source: a newer version is available. Same direct deploy
          path — triggerDeployment re-resolves the newest version server-side. */}
      {!isSelfApp && availableUpdate?.mode === "release" && (
        <WarningCallout
          title={t.projects.redeploy.newVersionTitle}
          description={
            <>
              {t.projects.redeploy.newVersionAvailable}{" "}
              <span className="font-mono text-foreground/80">v{availableUpdate.latestVersion}</span>
              {availableUpdate.currentVersion ? (
                <>
                  {" "}
                  {t.projects.redeploy.newVersionDeployed}{" "}
                  <span className="font-mono text-foreground/80">
                    v{availableUpdate.currentVersion}
                  </span>
                  .
                </>
              ) : (
                "."
              )}
            </>
          }
          actions={
            <button
              type="button"
              onClick={handleRedeploy}
              disabled={isRedeploying}
              className="rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
            >
              {isRedeploying ? t.projects.redeploy.deploying : t.projects.redeploy.deployVersion}
            </button>
          }
        />
      )}

      {!isSelfApp && availableUpdate?.mode === "image" && (
        <WarningCallout
          title={t.projectSettings.appSource.updateAvailable}
          description={availableUpdate.services?.filter((service) => service.behind)
            .map((service) => `${service.name} (${service.ref})`).join(", ")}
          actions={
            <button
              type="button"
              onClick={() => runRedeploy("update")}
              disabled={isRedeploying}
              className="rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
            >
              {isRedeploying ? t.projects.redeploy.deploying : t.projectSettings.appSource.update}
            </button>
          }
        />
      )}

      {!isSelfApp && (
        <div className="bg-card rounded-2xl border border-border/50 p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <UiIcon name="rocket" className="size-5" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  {t.projects.redeploy.deployLatestTitle}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {hasMultipleServices
                    ? t.projects.redeploy.deployLatestMulti
                    : t.projects.redeploy.deployLatestSingle}
                </p>
              </div>
            </div>

            {/* Primary action + a caret menu for the variants — one clean
              control instead of three competing buttons. */}
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={handleRedeploy}
                disabled={isRedeploying}
                className="inline-flex items-center justify-center rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-primary/50"
              >
                {isRedeploying
                  ? t.projects.redeploy.deployingButton
                  : t.projects.redeploy.redeployProject}
              </button>
              <DropdownMenu
                align="right"
                disabled={isRedeploying}
                triggerClassName="inline-flex items-center justify-center rounded-xl border border-border/60 bg-muted/30 p-2.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                trigger={<UiIcon name="chevron-down" className="size-4" />}
                actions={[
                  {
                    id: "refresh",
                    label: t.projects.redeploy.refreshEnv,
                    icon: <UiIcon name="refresh" className="size-4" />,
                    onClick: () => runRedeploy("refresh"),
                  },
                  ...(hasMultipleServices
                    ? [
                        {
                          id: "rebuild",
                          label: t.projects.redeploy.rebuildAll,
                          icon: <UiIcon name="layers" className="size-4" />,
                          onClick: () => runRedeploy("all"),
                        },
                      ]
                    : []),
                ]}
              />
            </div>
          </div>
        </div>
      )}

      <DeploymentsContent
        projectId={id}
        projectName={projectData.name}
        appTemplateId={projectData.isApp ? (projectData.appTemplateId ?? undefined) : undefined}
        hideHeader
        hideSidebar
      />
    </div>
  );
};
