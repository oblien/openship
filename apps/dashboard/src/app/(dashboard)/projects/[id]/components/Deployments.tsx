"use client";

import React from "react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { DeploymentsContent } from "@/app/(dashboard)/deployments/components";
import { deployApi, projectsApi, isAbortError, getApiErrorMessage } from "@/lib/api";
import { openTriggeredBuild } from "@/lib/deploy-nav";
import { type Service } from "@/lib/api/services";
import { useModal } from "@/context/ModalContext";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useRouter } from "next/navigation";
import { Rocket, ChevronDown, RefreshCw, Layers } from "lucide-react";
import DropdownMenu from "@/components/ui/DropdownMenu";
import WarningCallout from "@/components/shared/WarningCallout";

export const Deployments = () => {
  const {
    id,
    projectData,
    setActiveTab,
    servicesData,
    refreshServices,
    hasMultipleServices,
    updateProjectData,
  } = useProjectSettings();
  const { t } = useI18n();
  const { showToast } = useToast();
  const { showModal, hideModal } = useModal();
  const router = useRouter();

  const [isRedeploying, setIsRedeploying] = React.useState(false);
  const [isRetryingRoute, setIsRetryingRoute] = React.useState(false);
  // The Openship control-plane self-app has no deployable source and updates
  // itself via the CLI — redeploy/self-update controls would only 403, so hide them.
  const isSelfApp = projectData?.appTemplateId === "openship";

  /** Re-run just the free .opsh.io edge-route sync (no rebuild). On success the
   *  routing warning clears and the project flips back to Live; on failure the
   *  same guidance is re-surfaced as an error toast. */
  const handleRetryRouting = async () => {
    if (!projectData?.id || isRetryingRoute) return;
    setIsRetryingRoute(true);
    try {
      const res = await projectsApi.retryRouting(projectData.id);
      if (res?.ok) {
        updateProjectData({ routingUnsynced: false });
        showToast(t.projects.routingRetry.success, "success", t.projects.routingRetry.title);
      } else {
        showToast(
          res?.warning || res?.error || t.projects.routingRetry.failed,
          "error",
          t.projects.routingRetry.title,
        );
      }
    } catch (err) {
      showToast(
        getApiErrorMessage(err) || t.projects.routingRetry.failed,
        "error",
        t.projects.routingRetry.title,
      );
    } finally {
      setIsRetryingRoute(false);
    }
  };

  // "Project outdated" banner. Two shapes discriminated by `mode`: a commit
  // project is behind its branch HEAD; a release/dist project has a newer
  // version available. Fetched on-demand; conservative (only shows when we
  // positively know the deploy is behind and nothing is already in flight).
  const [commitStatus, setCommitStatus] = React.useState<{
    behind: boolean;
    mode: "commit" | "release";
    /* commit */
    branch?: string;
    latestSha?: string | null;
    latestMessage?: string | null;
    deployedSha?: string | null;
    /* release */
    latestVersion?: string | null;
    currentVersion?: string | null;
  } | null>(null);

  React.useEffect(() => {
    if (!projectData?.id) return;
    // The self-app updates via the CLI — no drift banner, so skip the fetch.
    if (isSelfApp) return;
    let cancelled = false;
    projectsApi
      .getCommitStatus(projectData.id)
      .then((res) => {
        if (cancelled) return;
        const s = res?.data;
        // Set when behind (and not already in flight), else CLEAR — must be
        // able to remove a stale banner, not only add one.
        setCommitStatus(
          s?.supported && s.behind && !s.latestInProgress
            ? {
                behind: true,
                mode: s.mode ?? "commit",
                branch: s.branch,
                latestSha: s.latestSha,
                latestMessage: s.latestMessage,
                deployedSha: s.deployedSha,
                latestVersion: s.latestVersion,
                currentVersion: s.currentVersion,
              }
            : null,
        );
      })
      .catch(() => {
        /* best-effort nudge; never block the page */
      });
    return () => {
      cancelled = true;
    };
    // activeDeploymentId dep → refetch after a deploy advances the live release.
  }, [projectData?.id, projectData?.activeDeploymentId, isSelfApp]);

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
    async (mode: "smart" | "all" | "refresh" = "smart") => {
      if (!projectData?.id) return;
      setIsRedeploying(true); // drive the loading state for menu paths too
      try {
        const body =
          mode === "all"
            ? { projectId: projectData.id, forceAll: true }
            : mode === "refresh"
              ? { projectId: projectData.id, refresh: true }
              : { projectId: projectData.id, smartRoute: true };
        const res = await deployApi.trigger(body);
        openTriggeredBuild(router, res, projectData.id);
      } catch (error) {
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
          mode === "refresh"
            ? t.projects.redeploy.couldNotRefresh
            : t.projects.redeploy.couldNotRedeploy,
          "error",
          t.projects.redeploy.errorTitle,
        );
        setIsRedeploying(false); // success navigates away; only clear on failure
      }
    },
    [projectData?.id, router, showToast, t],
  );

  const handleRedeploy = async () => {
    if (!projectData?.id || isRedeploying) return;

    setIsRedeploying(true);
    try {
      if (hasMultipleServices) {
        const services =
          servicesData.services.length > 0 ? servicesData.services : await refreshServices();
        if (shouldWarnAboutUnreachableServices(services)) {
          const candidateServices = services.filter(isPotentiallyPublicService);
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
                          setActiveTab("services");
                        }}
                      >
                        {t.projects.redeploy.openServices}
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
      {/* Routing-not-synced nudge — the release is live on the server but its
          free .opsh.io edge route didn't sync. A dedicated Retry re-runs just
          the edge sync (no rebuild); on success the warning clears. */}
      {projectData.routingUnsynced && !projectData.awaitingDecision && (
        <WarningCallout
          title={t.projects.routingRetry.title}
          description={t.projects.routingRetry.description}
          actions={
            <button
              type="button"
              onClick={handleRetryRouting}
              disabled={isRetryingRoute}
              className="rounded-lg bg-warning-solid px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-warning-solid/90 disabled:opacity-60"
            >
              {isRetryingRoute ? t.projects.routingRetry.retrying : t.projects.routingRetry.retry}
            </button>
          }
        />
      )}

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
      {!isSelfApp && commitStatus?.behind && commitStatus.mode === "commit" && (
        <WarningCallout
          title={t.projects.redeploy.newCommitTitle}
          description={
            <>
              <span className="font-mono text-foreground/80">
                {commitStatus.latestSha?.slice(0, 7)}
              </span>
              {commitStatus.latestMessage ? ` · ${commitStatus.latestMessage}` : ""}{" "}
              {t.projects.redeploy.newCommitOn}{" "}
              <span className="font-mono text-foreground/80">{commitStatus.branch}</span>
              {commitStatus.deployedSha ? (
                <>
                  {" "}
                  {t.projects.redeploy.newCommitDeployedOn}{" "}
                  <span className="font-mono text-foreground/80">
                    {commitStatus.deployedSha.slice(0, 7)}
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
      {!isSelfApp && commitStatus?.behind && commitStatus.mode === "release" && (
        <WarningCallout
          title={t.projects.redeploy.newVersionTitle}
          description={
            <>
              {t.projects.redeploy.newVersionAvailable}{" "}
              <span className="font-mono text-foreground/80">v{commitStatus.latestVersion}</span>
              {commitStatus.currentVersion ? (
                <>
                  {" "}
                  {t.projects.redeploy.newVersionDeployed}{" "}
                  <span className="font-mono text-foreground/80">
                    v{commitStatus.currentVersion}
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

      {!isSelfApp && (
        <div className="bg-card rounded-2xl border border-border/50 p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Rocket className="size-5" />
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
                trigger={<ChevronDown className="size-4" />}
                actions={[
                  {
                    id: "refresh",
                    label: t.projects.redeploy.refreshEnv,
                    icon: <RefreshCw className="size-4" />,
                    onClick: () => runRedeploy("refresh"),
                  },
                  ...(hasMultipleServices
                    ? [
                        {
                          id: "rebuild",
                          label: t.projects.redeploy.rebuildAll,
                          icon: <Layers className="size-4" />,
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

function hasConnectedDomain(service: Service) {
  if (!service.exposed) return false;
  if (service.domainType === "custom") return Boolean(service.customDomain?.trim());
  return Boolean(service.domain?.trim());
}

function isPotentiallyPublicService(service: Service) {
  return service.enabled && (service.ports?.length ?? 0) > 0;
}

function shouldWarnAboutUnreachableServices(services: Service[]) {
  const candidateServices = services.filter(isPotentiallyPublicService);
  if (candidateServices.length === 0) return false;
  return candidateServices.every((service) => !hasConnectedDomain(service));
}
