"use client";

import React, { useEffect, useCallback } from "react";
import { Loader2 } from "lucide-react";
import type { Terminal } from "@xterm/xterm";

import BuildTerminal from "../BuildTerminal";
import ServiceRow from "./ServiceRow";
import ComposeSidebar from "./ComposeSidebar";
import { generateIcon } from "@/utils/icons";
import { useRouter } from "next/navigation";
import { useDeployment } from "@/context/DeploymentContext";
import { useTheme } from "@/components/theme-provider";
import { useModal } from "@/context/ModalContext";
import { useToast } from "@/context/ToastContext";
import { deployApi } from "@/lib/api";

const warningDismissedKey = (deploymentId: string) => `compose-warning-dismissed:${deploymentId}`;

// ─── Main Component ──────────────────────────────────────────────────────────

interface Props {
  onRedeploy: () => void;
}

const ComposeDeploymentProcessing: React.FC<Props> = ({ onRedeploy }) => {
  const {
    config,
    state,
    terminalRef,
    onTerminalReady,
    stopDeployment,
    respondToPrompt,
    deploymentStatus,
  } = useDeployment();
  const { resolvedTheme } = useTheme();
  const { showModal, hideModal } = useModal();
  const { showToast } = useToast();
  const router = useRouter();
  const promptModalRef = React.useRef<string | null>(null);
  const warningModalRef = React.useRef<string | null>(null);
  const handledWarningDeploymentRef = React.useRef<string | null>(null);

  const hasWarning = deploymentStatus === "ready" && !!state.warningMessage;
  const isFinished = deploymentStatus === "ready" || deploymentStatus === "failed" || deploymentStatus === "cancelled";
  const services = state.serviceStatuses;
  const total = services.length;
  const running = services.filter((s) => s.status === "running").length;
  const built = services.filter((s) => s.status === "built").length;
  const building = services.filter((s) => s.status === "building").length;
  const failed = services.filter((s) => s.status === "failed").length;
  const settled = running + built + failed;

  // ── Pipeline prompt modal ──────────────────────────────────────────────
  useEffect(() => {
    if (!state.pendingPrompt) return;
    const { promptId, title, message, actions } = state.pendingPrompt;
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
          <div className="flex items-center justify-end gap-3 pt-2">
            {actions.map((action) => {
              const variant = (action.variant || "secondary") as "secondary" | "danger" | "primary";
              const styles = variant === "danger"
                ? "bg-red-600 text-white hover:bg-red-700"
                : variant === "primary"
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "border border-border bg-muted text-foreground hover:bg-muted/80";
              return (
                <button
                  key={action.id}
                  type="button"
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${styles}`}
                  onClick={() => { hideModal(modalId); respondToPrompt(action.id); }}
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

  useEffect(() => {
    if (deploymentStatus !== "ready" || !state.warningMessage || failed === 0 || !state.deploymentId) {
      warningModalRef.current = null;
      handledWarningDeploymentRef.current = null;
      return;
    }

    const warningKey = warningDismissedKey(state.deploymentId);

    if (typeof window !== "undefined" && window.sessionStorage.getItem(warningKey) === "1") {
      handledWarningDeploymentRef.current = state.deploymentId;
      return;
    }

    if (handledWarningDeploymentRef.current === state.deploymentId) return;
    if (warningModalRef.current) return;

    let modalId = "";
    modalId = showModal({
      customContent: (
        <PartialSuccessModalContent
          failed={failed}
          total={total}
          warningMessage={state.warningMessage}
          onKeep={() => {
            handledWarningDeploymentRef.current = state.deploymentId;
            if (typeof window !== "undefined") {
              window.sessionStorage.setItem(warningKey, "1");
            }
            hideModal(modalId);
          }}
          onReject={async () => {
            handledWarningDeploymentRef.current = state.deploymentId;
            if (typeof window !== "undefined") {
              window.sessionStorage.setItem(warningKey, "1");
            }

            await deployApi.reject(state.deploymentId!);
            hideModal(modalId);
            showToast("Partial deployment rejected", "success", "Deployment Reverted");

            if (state.projectId) {
              router.push(`/projects/${state.projectId}`);
            }
          }}
        />
      ),
      width: "640px",
      maxWidth: "92vw",
      showCloseButton: true,
      onClose: () => {
        if (warningModalRef.current === modalId) {
          warningModalRef.current = null;
        }
        handledWarningDeploymentRef.current = state.deploymentId;
        if (typeof window !== "undefined") {
          window.sessionStorage.setItem(warningKey, "1");
        }
      },
    });

    warningModalRef.current = modalId;
  }, [deploymentStatus, failed, hideModal, router, showModal, showToast, state.deploymentId, state.projectId, state.warningMessage, total]);

  const handleTerminalReady = useCallback(
    (terminal: Terminal) => {
      if (terminalRef) terminalRef.current = terminal;
      onTerminalReady();
    },
    [terminalRef, onTerminalReady],
  );

  const handleViewDashboard = () => {
    if (state.projectId) router.push(`/projects/${state.projectId}`);
  };

  // ── Title ──────────────────────────────────────────────────────────────
  const title = deploymentStatus === "cancelled"
    ? "Deployment Cancelled"
    : deploymentStatus === "failed"
      ? "Deployment Failed"
      : hasWarning
        ? "Deployed With Warnings"
        : deploymentStatus === "ready"
          ? "Deployment Successful"
          : "Deploying Services…";

  return (
    <div className="min-h-screen bg-background mx-auto md:px-12">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="py-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex border border-border/50 bg-muted/50 rounded-lg w-12 h-12 justify-center items-center">
              {generateIcon("space%20rocket-85-1687505546.png", 30, "currentColor")}
            </div>
            <div>
              <h1 className="text-xl font-semibold text-foreground">{title}</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                {config.owner}/{config.repo}
                {total > 0 && (
                  <span className="ml-2 text-xs">
                    · {total} service{total !== 1 ? "s" : ""}
                  </span>
                )}
              </p>
            </div>
          </div>

          {deploymentStatus === "ready" && (
            <button
              onClick={handleViewDashboard}
              className="flex items-center gap-2 text-primary-foreground font-medium bg-primary rounded-full px-4 py-2 text-sm hover:bg-primary/90 shadow-md hover:shadow-lg transition-all"
            >
              View Dashboard
            </button>
          )}
        </div>
      </div>

      {/* ── Grid ───────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main column */}
        <div className="lg:col-span-2 space-y-6">

          {/* Warning banner */}
          {hasWarning && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/8 px-5 py-4">
              <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
                Some services need attention
              </p>
              <p className="mt-1 text-sm text-amber-700/80 dark:text-amber-300/80">
                {state.warningMessage}
              </p>
            </div>
          )}

          {/* Services section */}
          <div className="bg-card rounded-2xl border border-border/50 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-normal text-foreground">Services</h2>

              {/* Compact inline progress */}
              {total > 0 && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {running}/{total} running
                  {building > 0 && (
                    <span className="ml-1">· {building} building</span>
                  )}
                  {failed > 0 && (
                    <span className="text-destructive ml-1">· {failed} failed</span>
                  )}
                </span>
              )}
            </div>

            {/* Progress bar */}
            {!isFinished && total > 0 && (
              <div className="mb-4">
                <div className="h-1 rounded-full overflow-hidden bg-border/50">
                  <div
                    className="h-full transition-all duration-500 bg-primary"
                    style={{
                      width: `${(settled / total) * 100}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {/* Service rows */}
            {services.length > 0 ? (
              <div className="space-y-1.5">
                {services.map((svc) => (
                  <ServiceRow key={svc.serviceId} service={svc} />
                ))}
              </div>
            ) : !isFinished ? (
              <div className="flex items-center gap-3 text-sm text-muted-foreground py-6 justify-center">
                <Loader2 className="w-4 h-4 animate-spin" />
                Preparing services…
              </div>
            ) : null}
          </div>

          {/* Build Terminal */}
          <div className="bg-card rounded-2xl border border-border/50 p-6 mb-20">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                {generateIcon("terminal-58-1658431404.png", 24, "currentColor")}
                <h2 className="text-base font-normal text-foreground">Build Logs</h2>
              </div>
              {deploymentStatus === "failed" && (
                <span className="text-sm text-muted-foreground">See logs for details</span>
              )}
            </div>
            <div className="bg-white dark:bg-black border border-border/50 rounded-xl overflow-hidden h-[400px]">
              <BuildTerminal onReady={handleTerminalReady} mockData={false} theme={resolvedTheme} />
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="lg:sticky lg:top-6 h-fit space-y-6">
          <ComposeSidebar />

          {/* Action button */}
          <div className="bg-card rounded-2xl border border-border/50 p-4">
            {(deploymentStatus === "deploying" || deploymentStatus === "building") ? (
              <button
                onClick={stopDeployment}
                disabled={state.isStopping}
                className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl transition-all font-medium text-sm border ${
                  state.isStopping
                    ? "bg-muted text-muted-foreground border-border cursor-not-allowed"
                    : "bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/15 hover:border-destructive/30"
                }`}
              >
                {state.isStopping ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Stopping…
                  </>
                ) : (
                  "Stop Deployment"
                )}
              </button>
            ) : deploymentStatus === "failed" || deploymentStatus === "cancelled" ? (
              <button
                onClick={onRedeploy}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-xl font-medium text-sm hover:bg-primary/90 transition-all"
              >
                Redeploy
              </button>
            ) : deploymentStatus === "ready" ? (
              <button
                onClick={handleViewDashboard}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-xl font-medium text-sm hover:bg-primary/90 transition-all"
              >
                Open Dashboard
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ComposeDeploymentProcessing;

function PartialSuccessModalContent({
  failed,
  total,
  warningMessage,
  onKeep,
  onReject,
}: {
  failed: number;
  total: number;
  warningMessage: string;
  onKeep: () => void;
  onReject: () => Promise<void>;
}) {
  const [isRejecting, setIsRejecting] = React.useState(false);

  return (
    <div className="p-6 space-y-5">
      <div className="space-y-2">
        <h3 className="text-xl font-bold text-foreground">Deployment finished with failed services</h3>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {failed} of {total} services failed, but the rest of the stack was deployed successfully.
          You can keep this deployment and fix the failed services later, or reject it and restore the previous deployment.
        </p>
      </div>

      <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 p-4 space-y-2">
        <p className="text-xs uppercase tracking-wide text-amber-700 dark:text-amber-300">Warning</p>
        <p className="text-sm text-amber-700/90 dark:text-amber-300/90">{warningMessage}</p>
      </div>

      <div className="rounded-xl border border-border bg-muted/40 p-4">
        <p className="text-sm text-muted-foreground">
          Rejecting stops using this partial deployment. If a previous deployment exists, Openship restores it. Otherwise, the new partial deployment is removed.
        </p>
      </div>

      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="button"
          className="rounded-lg border border-border bg-muted px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/80"
          onClick={onKeep}
          disabled={isRejecting}
        >
          Keep And Fix Later
        </button>
        <button
          type="button"
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
          onClick={async () => {
            setIsRejecting(true);
            try {
              await onReject();
            } finally {
              setIsRejecting(false);
            }
          }}
          disabled={isRejecting}
        >
          {isRejecting ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Rejecting...
            </span>
          ) : (
            "Reject Deployment"
          )}
        </button>
      </div>
    </div>
  );
}
