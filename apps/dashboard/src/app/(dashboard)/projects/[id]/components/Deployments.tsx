"use client";

import React from "react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { DeploymentsContent } from "@/app/(dashboard)/deployments/components";
import { deployApi, projectsApi, isAbortError } from "@/lib/api";
import { type Service } from "@/lib/api/services";
import { useModal } from "@/context/ModalContext";
import { useToast } from "@/context/ToastContext";
import { useRouter } from "next/navigation";
import { Rocket, ChevronDown, RefreshCw, Layers } from "lucide-react";
import DropdownMenu from "@/components/ui/DropdownMenu";
import WarningCallout from "@/components/shared/WarningCallout";

export const Deployments = () => {
  const { id, projectData, setActiveTab, servicesData, refreshServices, hasMultipleServices } =
    useProjectSettings();
  const { showToast } = useToast();
  const { showModal, hideModal } = useModal();
  const router = useRouter();

  const [isRedeploying, setIsRedeploying] = React.useState(false);

  // "Project outdated" banner: branch HEAD vs the active deployment's commit.
  // Fetched on-demand; conservative (only shows when we positively know the
  // deployed commit is behind the remote HEAD).
  const [commitStatus, setCommitStatus] = React.useState<{
    behind: boolean;
    branch?: string;
    latestSha?: string | null;
    latestMessage?: string | null;
    deployedSha?: string | null;
  } | null>(null);

  React.useEffect(() => {
    if (!projectData?.id) return;
    let cancelled = false;
    projectsApi
      .getCommitStatus(projectData.id)
      .then((res) => {
        if (cancelled) return;
        const s = res?.data;
        // Set when behind HEAD (and not already in flight), else CLEAR — must be
        // able to remove a stale banner, not only add one.
        setCommitStatus(
          s?.supported && s.behind && !s.latestInProgress
            ? {
                behind: true,
                branch: s.branch,
                latestSha: s.latestSha,
                latestMessage: s.latestMessage,
                deployedSha: s.deployedSha,
              }
            : null,
        );
      })
      .catch(() => { /* best-effort nudge; never block the page */ });
    return () => {
      cancelled = true;
    };
    // activeDeploymentId dep → refetch after a deploy advances the live release.
  }, [projectData?.id, projectData?.activeDeploymentId]);

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
  const runRedeploy = React.useCallback(async (mode: "smart" | "all" | "refresh" = "smart") => {
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
      const newId = res?.data?.deployment?.id;
      router.push(newId ? `/build/${newId}` : `/projects/${projectData.id}/deployments`);
    } catch (error) {
      // A timeout almost certainly means the server started the deploy but was
      // slow to return the id — show the deployments list so it's visible rather
      // than stranding the user on an error.
      if (isAbortError(error)) {
        showToast("Deploy started — taking longer than usual, opening deployments.", "success", "Deploying");
        router.push(`/projects/${projectData.id}/deployments`);
        return;
      }
      console.error("Redeploy failed:", error);
      showToast(
        mode === "refresh"
          ? "Could not refresh the deployment. Check the deployment log for details."
          : "Could not start redeployment. Check the deployment log for details.",
        "error",
        "Error",
      );
      setIsRedeploying(false); // success navigates away; only clear on failure
    }
  }, [projectData?.id, router, showToast]);

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
                  title="No public domain is connected"
                  description={
                    <>
                      This project has {candidateServices.length} service
                      {candidateServices.length !== 1 ? "s" : ""} with exposed ports, but none are
                      configured with a reachable domain. If you deploy now, the stack can run
                      internally, but users will not be able to access it from a public URL.
                    </>
                  }
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
                        Open Services
                      </button>
                      <button
                        type="button"
                        className="rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                        onClick={async () => {
                          hideModal(modalId);
                          await runRedeploy();
                        }}
                      >
                        Deploy anyway
                      </button>
                    </>
                  }
                >
                  <div className="mt-3 rounded-xl border border-border/50 bg-background/40 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
                      Suggested fix
                    </p>
                    <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[12px] text-muted-foreground">
                      <li>Open the Services tab.</li>
                      <li>Pick the service that should be public.</li>
                      <li>Enable domain exposure and choose the public port.</li>
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
      showToast("Failed to start redeployment", "error", "Error");
    } finally {
      setIsRedeploying(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Action-required nudge — the live release is a partial-failure deploy
          still awaiting a keep/reject decision. Links to the build screen where
          the decision (Keep / Retry / Reject) lives, so it stays reachable after
          navigating away. */}
      {projectData.awaitingDecision && projectData.activeDeploymentId && (
        <WarningCallout
          title="Action required — some services failed"
          description="This project's latest release deployed with failed services and is waiting for you to keep or reject it."
          actions={
            <button
              type="button"
              onClick={() => router.push(`/build/${projectData.activeDeploymentId}`)}
              className="rounded-lg bg-amber-600 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-amber-700"
            >
              Review deployment
            </button>
          }
        />
      )}

      {/* "Project outdated" nudge — only when the deployed commit is behind the
          branch HEAD. Redeploy uses the same direct path as the button below. */}
      {commitStatus?.behind && (
        <WarningCallout
          title="New commit available"
          description={
            <>
              <span className="font-mono text-foreground/80">
                {commitStatus.latestSha?.slice(0, 7)}
              </span>
              {commitStatus.latestMessage ? ` · ${commitStatus.latestMessage}` : ""} on{" "}
              <span className="font-mono text-foreground/80">{commitStatus.branch}</span>
              {commitStatus.deployedSha ? (
                <>
                  {" "}— you're deployed on{" "}
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
              {isRedeploying ? "Deploying…" : "Redeploy latest"}
            </button>
          }
        />
      )}

      <div className="bg-card rounded-2xl border border-border/50 p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Rocket className="size-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">Deploy Latest Changes</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {hasMultipleServices
                  ? "Pulls the latest commit and rebuilds only the services whose files changed since the last deploy."
                  : "Pulls the latest commit and redeploys using the current configuration."}
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
              {isRedeploying ? "Deploying..." : "Redeploy Project"}
            </button>
            <DropdownMenu
              align="right"
              disabled={isRedeploying}
              triggerClassName="inline-flex items-center justify-center rounded-xl border border-border/60 bg-muted/30 p-2.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              trigger={<ChevronDown className="size-4" />}
              actions={[
                {
                  id: "refresh",
                  label: "Refresh env",
                  icon: <RefreshCw className="size-4" />,
                  onClick: () => runRedeploy("refresh"),
                },
                ...(hasMultipleServices
                  ? [
                      {
                        id: "rebuild",
                        label: "Rebuild all",
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

      <DeploymentsContent projectId={id} projectName={projectData.name} hideHeader hideSidebar />
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
