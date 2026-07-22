"use client";

import React, { useState, useEffect, useCallback, memo } from "react";
import Image from "next/image";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  Server,
  Cloud,
  Globe,
  GitBranch,
  Hammer,
  Layers,
} from "lucide-react";
import type { Terminal } from "@xterm/xterm";
import BuildTerminal from "./BuildTerminal";
import { PortAdvisoryModal } from "./PortAdvisoryModal";
import { PromptDetails } from "./PromptDetails";
import { generateIcon } from "@/utils/icons";
import { useRouter } from "next/navigation";
import { encodeRepoSlug } from "@/utils/repoSlug";
import { useDeployment } from "@/context/DeploymentContext";
import { getPublicEndpointHosts } from "@/context/deployment/types";
import { resolveBuildElapsedMs } from "@/context/deployment/types";
import { usePlatform } from "@/context/PlatformContext";
import { useTheme } from "@/components/theme-provider";
import { useModal } from "@/context/ModalContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { Dictionary } from "@/i18n";

interface DeploymentProcessingProps {
  // Resolves to the new deployment id (navigates on success) or null on failure.
  onRedeploy: () => void | Promise<string | null>;
}

/** Compact duration label: "8s", "1m 02s". */
function formatDurationMs(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

/** Human label for the build/deploy target shown in Deployment Details. */
function describeBuildTarget(config: {
  deployTarget: string;
  serverName?: string;
}, t: Dictionary): string {
  const dp = t.importProject.deploymentProcessing;
  if (config.deployTarget === "cloud") return dp.targetOpenshipCloud;
  if (config.deployTarget === "server") {
    return config.serverName ? interpolate(dp.targetServerNamed, { name: config.serverName }) : dp.targetServer;
  }
  if (config.deployTarget === "local") return dp.targetLocal;
  return "—";
}

/** Where the build runs (vs where it deploys, shown by Instance). Concise so it
 *  fits the narrow info column without truncating. */
function describeBuildStrategy(config: {
  deployTarget: string;
  buildStrategy: string;
}, t: Dictionary): string {
  const dp = t.importProject.deploymentProcessing;
  if (config.buildStrategy === "local") return dp.strategyLocal;
  if (config.deployTarget === "cloud") return dp.strategyCloud;
  if (config.deployTarget === "server") return dp.strategyServer;
  return dp.strategyHost;
}

/** One themed row in the Deployment Details list: colored icon chip + label + value. */
function DetailRow({
  icon: Icon,
  label,
  value,
  chipClass = "bg-muted/60",
  iconClass = "text-muted-foreground",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
  chipClass?: string;
  iconClass?: string;
}) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${chipClass}`}>
        <Icon className={`size-4 ${iconClass}`} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className="text-sm font-medium text-foreground truncate">{value}</div>
      </div>
    </div>
  );
}

const DeploymentProcessing: React.FC<DeploymentProcessingProps> = ({ onRedeploy }) => {
  const { config, state, terminalRef, onTerminalReady, stopDeployment, respondToPrompt, steps, deploymentStatus } = useDeployment();
  const { baseDomain } = usePlatform();
  const { resolvedTheme } = useTheme();
  const { showModal, hideModal } = useModal();
  const { t } = useI18n();
  const dp = t.importProject.deploymentProcessing;
  const router = useRouter();
  const promptModalRef = React.useRef<string | null>(null);
  // Holds the Redeploy button's spinner from click until the redeploy resolves
  // and navigates to the new deployment (or re-enables on failure).
  const [isRedeploying, setIsRedeploying] = useState(false);

  // ── Pipeline prompt modal (port conflict / edge takeover) ──────────────
  useEffect(() => {
    if (!state.pendingPrompt) return;
    const { promptId, title, message, actions, details } = state.pendingPrompt;
    if (promptModalRef.current === promptId) return;
    promptModalRef.current = promptId;

    const modalId = showModal({
      title,
      icon: "error%20triangle-16-1662499385.png",
      customContent: (
        <div className="p-6 space-y-5">
          <div className="space-y-2">
            <h3 className="text-xl font-bold text-foreground">{title}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{message}</p>
          </div>

          <PromptDetails details={details} />

          <div className="flex items-center justify-end gap-3 pt-2">
            {actions.map((action) => {
              const variant = (action.variant || "secondary") as "secondary" | "danger" | "primary";
              const styles = variant === "danger"
                ? "bg-danger-solid text-white hover:bg-danger-solid/90"
                : variant === "primary"
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "border border-border bg-muted text-foreground hover:bg-muted/80";

              return (
                <button
                  key={action.id}
                  type="button"
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${styles}`}
                  onClick={() => {
                    hideModal(modalId);
                    respondToPrompt(action.id);
                  }}
                >
                  {action.label}
                </button>
              );
            })}
          </div>
        </div>
      ),
      width: "560px",
      maxWidth: "92vw",
    });
  }, [state.pendingPrompt, showModal, hideModal, respondToPrompt]);

  // Build domain for display
  const endpointHosts = getPublicEndpointHosts(config.publicEndpoints, baseDomain, config.projectName);
  const domain = endpointHosts[0] ?? "";
  const extraEndpointCount = endpointHosts.length > 1 ? endpointHosts.length - 1 : 0;

  const handleTerminalReady = useCallback((terminal: Terminal) => {
    if (terminalRef) {
      terminalRef.current = terminal;
    }
    onTerminalReady();
  }, [terminalRef, onTerminalReady]);

  const handleViewDashboard = () => {
    if (state.projectId) {
      router.push(`/projects/${state.projectId}`);
    }
  };

  const hasWarning = deploymentStatus === "ready" && !!state.warningMessage;

  return (
    <div className="min-h-screen bg-background max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="bg-background">
        <div className="py-5 relative">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div>
                <h1 className="text-xl font-semibold text-foreground">
                  {deploymentStatus === "cancelled"
                    ? dp.title.cancelled
                    : deploymentStatus === "failed"
                      ? dp.title.failed
                      : hasWarning
                        ? dp.title.readyWarnings
                        : deploymentStatus === "ready"
                        ? dp.title.successful
                        : dp.title.deploying}
                </h1>
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {config.owner}/{config.repo}
                  </p>
                </div>
              </div>
            </div>

            {deploymentStatus === "ready" && (
              <div className="flex items-center gap-2">
                <button
                  onClick={handleViewDashboard}
                  className="flex items-center gap-2 text-foreground font-medium transition-all duration-300 bg-card rounded-xl px-4 py-2 text-sm border border-border hover:shadow-md"
                >
                  {dp.viewDashboard}
                </button>
                <button
                  onClick={() => window.open(`https://${domain}`, "_blank")}
                  className="flex items-center gap-2 text-primary-foreground font-medium transition-all duration-300 bg-primary rounded-xl px-4 py-2 text-sm hover:bg-primary/90 shadow-md hover:shadow-lg"
                >
                  {dp.visitSite}
                  {generateIcon('External_link_HtLszLDBXqHilHK674zh2aKoSL7xUhyboAzP.png', 16, '#fff')}
                </button>
              </div>
            )}

          </div>
        </div>
      </div>

      <div className="w-full">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            {hasWarning && (
              <div className="rounded-2xl border border-warning-border bg-warning-bg px-4 py-3">
                <p className="text-sm font-medium text-warning">
                  {dp.warningTitle}
                </p>
                <p className="mt-1 text-sm text-warning/80">
                  {state.warningMessage}
                </p>
              </div>
            )}

            {deploymentStatus === "ready" && (
              <PortAdvisoryModal
                deploymentId={state.deploymentId}
                projectId={state.projectId ?? config.projectId}
                checks={state.portCheck}
                skipped={state.portCheckSkipped}
                isCompose={false}
                publicEndpoints={config.publicEndpoints}
              />
            )}

            {/* Steps — progress tracker above the terminal. */}
            <div className="bg-card rounded-2xl border border-border/50 px-7 py-6">
              <div className="relative">
                <div className="absolute top-5 start-5 end-5 h-[2px] bg-border/50 z-0">
                  <div
                    className="h-full bg-primary transition-all duration-500"
                    style={{ width: `${(state.currentStepIndex / (steps.length - 1)) * 100}%` }}
                  />
                </div>
                <div className="relative flex justify-between z-10">
                  {steps.map((step, index) => {
                    const isCompleted = index < state.currentStepIndex;
                    const isCurrent =
                      index === state.currentStepIndex &&
                      !state.deploymentSuccess &&
                      !state.deploymentFailed &&
                      !state.deploymentCanceled;
                    const hasFailed =
                      (state.deploymentFailed || state.deploymentCanceled) &&
                      index === state.currentStepIndex;
                    const isReady = state.deploymentSuccess && index === steps.length - 1;
                    return (
                      <div key={index} className="flex flex-col items-center gap-2.5 z-10">
                        <div
                          style={{ boxShadow: "0 0 0 6px var(--th-card-bg-solid)" }}
                          className={`rounded-full flex items-center justify-center w-10 h-10 transition-all duration-300 ${
                            hasFailed
                              ? "bg-destructive"
                              : isReady || isCompleted
                                ? "bg-primary"
                                : isCurrent
                                  ? "bg-foreground"
                                  : // Pending: SOLID fill (the `bg-muted` token is a
                                    // translucent surface tint, so the connector line
                                    // showed through). Use the solid card color so the
                                    // line is fully occluded under the circle.
                                    "bg-[var(--th-card-bg-solid)] border border-border"
                          }`}
                        >
                          {hasFailed ? (
                            <XCircle className="w-5 h-5 text-white" />
                          ) : isReady || isCompleted ? (
                            <CheckCircle2 className="w-5 h-5 text-primary-foreground" />
                          ) : isCurrent ? (
                            <Loader2 className="w-5 h-5 text-background animate-spin" />
                          ) : (
                            generateIcon(step.icon, 18, "var(--th-text-muted)")
                          )}
                        </div>
                        <span
                          className={`text-sm font-medium ${
                            hasFailed || isCompleted || isCurrent || isReady
                              ? "text-foreground"
                              : "text-muted-foreground"
                          }`}
                        >
                          {step.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Build Terminal */}
            <div className="bg-card rounded-2xl border border-border/50 p-6 mb-20">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  {generateIcon('terminal-58-1658431404.png', 24, 'currentColor')}
                  <h2 className="text-base font-normal text-foreground">
                    {state.deploymentSuccess && config.options.hasServer ? dp.productionLogs : dp.buildTerminal}
                  </h2>
                </div>
                {deploymentStatus === "failed" && (
                  <span className="text-sm font-normal text-muted-foreground">{dp.seeLogs}</span>
                )}
              </div>

              <div className="bg-white dark:bg-black dim:bg-black border border-border/50 rounded-xl overflow-hidden h-[400px]">
                <BuildTerminal
                  onReady={handleTerminalReady}
                  theme={resolvedTheme === "light" ? "light" : "dark"}
                />
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div className="lg:sticky lg:top-6 h-fit space-y-6">
            {/* Build phases — per-phase timings; "prepare" is the one-time
                server provisioning, excluded from the build clock below. */}
            {/* Deployment details — clean info list */}
            <DeploymentDetails />

            {/* Actions — under the details card */}
            <div className="bg-card rounded-2xl border border-border/50 p-4">
              {isRedeploying ? (
                <button
                  disabled
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl transition-all font-medium text-sm bg-primary/60 text-primary-foreground cursor-not-allowed"
                >
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {dp.redeploying}
                </button>
              ) : deploymentStatus === "deploying" || deploymentStatus === "building" ? (
                <button
                  onClick={stopDeployment}
                  disabled={state.isStopping}
                  className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl transition-all font-medium text-sm border ${state.isStopping
                    ? 'bg-muted text-muted-foreground border-border cursor-not-allowed'
                    : 'bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/15 hover:border-destructive/30'
                    }`}
                >
                  {state.isStopping ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {dp.stopping}
                    </>
                  ) : (
                    dp.stopDeployment
                  )}
                </button>
              ) : (deploymentStatus === "failed" || deploymentStatus === "cancelled") ? (
                <div className="space-y-2">
                  <button
                    onClick={async () => {
                      if (isRedeploying) return;
                      setIsRedeploying(true);
                      // Keep the spinner up until the redeploy request resolves
                      // and navigates to the new deployment; re-enable on failure.
                      try {
                        await onRedeploy();
                      } finally {
                        setIsRedeploying(false);
                      }
                    }}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-xl transition-all font-medium text-sm hover:bg-primary/90"
                  >
                    {dp.redeploy}
                  </button>
                  {state.projectId && (
                    <button
                      onClick={() => router.push(`/projects/${state.projectId}`)}
                      className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl transition-all font-medium text-sm border border-border bg-card text-foreground hover:bg-muted"
                    >
                      {dp.goToProject}
                    </button>
                  )}
                </div>
              ) : (deploymentStatus === "ready") ? (
                <button
                  onClick={handleViewDashboard}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-xl transition-all font-medium text-sm hover:bg-primary/90"
                >
                  {dp.openDashboard}
                </button>
              ) : null}
            </div>

          </div>
        </div>
      </div>

    </div>
  );
};

/** Live-ticking total build time (excludes one-time prep). Isolated so the 1s
 *  tick re-renders only this label, not the whole page. */
const BuildTimeLabel = memo(() => {
  const { state } = useDeployment();
  const [, setTick] = useState(0);
  const isLive =
    !state.deploymentSuccess && !state.deploymentFailed && !state.deploymentCanceled;
  useEffect(() => {
    if (!isLive) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [isLive]);
  return <>{formatDurationMs(resolveBuildElapsedMs(state))}</>;
});
BuildTimeLabel.displayName = "BuildTimeLabel";

const DeploymentDetails = memo(() => {
  const { state, deploymentStatus, config } = useDeployment();
  const { baseDomain } = usePlatform();
  const { t } = useI18n();
  const dp = t.importProject.deploymentProcessing;
  const router = useRouter();
  const hasWarning = deploymentStatus === "ready" && !!state.warningMessage;
  const endpointHosts = getPublicEndpointHosts(config.publicEndpoints, baseDomain, config.projectName);
  const domain = endpointHosts[0] ?? "";
  const extraEndpointCount = endpointHosts.length > 1 ? endpointHosts.length - 1 : 0;

  const handleEdit = () => {
    const slug = encodeRepoSlug(config.owner, config.repo);
    const params = new URLSearchParams({ force: "true" });
    const projectId = state.projectId || config.projectId;

    if (projectId) {
      params.set("projectId", projectId);
    } else if (config.branch) {
      params.set("branch", config.branch);
    }

    router.push(`/deploy/${slug}?${params.toString()}`);
  };

  const statusLabel = deploymentStatus === "cancelled"
    ? dp.status.cancelled
    : deploymentStatus === "failed"
      ? dp.status.failed
      : hasWarning
        ? dp.status.readyWarnings
        : deploymentStatus === "ready"
          ? dp.status.ready
          : dp.status.building;
  const statusColor =
    deploymentStatus === "failed" || deploymentStatus === "cancelled"
      ? "text-destructive"
      : hasWarning
        ? "text-warning"
        : deploymentStatus === "ready"
          ? "text-primary"
          : "text-foreground";
  const statusBg =
    deploymentStatus === "failed" || deploymentStatus === "cancelled"
      ? "bg-destructive/10"
      : hasWarning
        ? "bg-warning-bg"
        : deploymentStatus === "ready"
          ? "bg-primary/10"
          : "bg-muted/60";
  const statusIcon =
    deploymentStatus === "failed" || deploymentStatus === "cancelled" ? (
      <XCircle className="size-4 text-destructive" />
    ) : hasWarning ? (
      <CheckCircle2 className="size-4 text-warning" />
    ) : deploymentStatus === "ready" ? (
      <CheckCircle2 className="size-4 text-primary" />
    ) : (
      <Loader2 className="size-4 text-foreground animate-spin" />
    );
  const InstanceIcon = config.deployTarget === "cloud" ? Cloud : Server;
  const domainValue = domain
    ? `${domain}${extraEndpointCount > 0 ? ` +${extraEndpointCount}` : ""}`
    : "—";

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-base font-normal text-foreground">{dp.detailsTitle}</h3>
        {(state.deploymentCanceled || state.deploymentFailed) && (
          <button onClick={handleEdit} className="flex items-center gap-2 -me-1 cursor-pointer opacity-50 hover:opacity-100 transition-all duration-300">
            <span className="text-sm text-foreground">{dp.edit}</span>
            {generateIcon('pen-404-1658238246.png', 18, 'currentColor')}
          </button>
        )}
      </div>
      <div className="space-y-4">
        {/* Status — tinted chip + colored value */}
        <div className="flex items-center gap-3 min-w-0">
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${statusBg}`}>
            {statusIcon}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">{dp.detailStatus}</p>
            <p className={`text-sm font-medium truncate ${statusColor}`}>{statusLabel}</p>
          </div>
        </div>
        <DetailRow icon={InstanceIcon} label={dp.detailInstance} value={describeBuildTarget(config, t)} />
        <DetailRow icon={Hammer} label={dp.detailBuild} value={describeBuildStrategy(config, t)} />
        <DetailRow icon={Clock} label={dp.detailBuildTime} value={<BuildTimeLabel />} />
        <DetailRow icon={Layers} label={dp.detailFramework} value={config.framework} />
        <DetailRow icon={GitBranch} label={dp.detailBranch} value={config.branch} />
        <DetailRow icon={Globe} label={extraEndpointCount > 0 ? dp.detailDomains : dp.detailDomain} value={domainValue} />
      </div>
    </div>
  );
});

DeploymentDetails.displayName = "DeploymentDetails";

export default DeploymentProcessing;
