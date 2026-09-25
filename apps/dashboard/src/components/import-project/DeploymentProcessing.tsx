"use client";

import React, { useEffect, useCallback } from "react";
import type { Terminal } from "@xterm/xterm";
import BuildTerminal from "./BuildTerminal";
import { DeploymentHeader } from "./DeploymentHeader";
import { DeploymentLayout } from "./DeploymentLayout";
import { DeploymentLogsPanel } from "./DeploymentLogsPanel";
import DeploymentDetails from "./DeploymentDetails";
import { DeploymentStepper } from "./DeploymentStepper";
import { PageContainer } from "@/components/ui/PageContainer";
import { PortAdvisoryModal } from "./PortAdvisoryModal";
import { PromptDetails } from "./PromptDetails";
import { useDeployment } from "@/context/DeploymentContext";
import { useTheme } from "@/components/theme-provider";
import { useModal } from "@/context/ModalContext";
import { useI18n } from "@/components/i18n-provider";

interface DeploymentProcessingProps {
  // Resolves to the new deployment id (navigates on success) or null on failure.
  onRedeploy: () => void | Promise<string | null>;
}

const DeploymentProcessing: React.FC<DeploymentProcessingProps> = ({ onRedeploy }) => {
  const { config, state, terminalRef, onTerminalReady, respondToPrompt, deploymentStatus } =
    useDeployment();
  const { resolvedTheme } = useTheme();
  const { showModal, hideModal } = useModal();
  const { t } = useI18n();
  const dp = t.importProject.deploymentProcessing;
  const promptModalRef = React.useRef<string | null>(null);
  // ── Pipeline prompt modal (port conflict / edge takeover) ──────────────
  useEffect(() => {
    if (!state.pendingPrompt) return;
    const { promptId, title, message, actions, details } = state.pendingPrompt;
    if (promptModalRef.current === promptId) return;
    promptModalRef.current = promptId;

    const modalId = showModal({
      title,
      icon: "warning",
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
              const styles =
                variant === "danger"
                  ? "bg-danger-solid text-white hover:bg-danger-solid/90"
                  : variant === "primary"
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "bg-secondary text-secondary-foreground hover:bg-secondary/80";

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

  const handleTerminalReady = useCallback(
    (terminal: Terminal) => {
      if (terminalRef) {
        terminalRef.current = terminal;
      }
      onTerminalReady();
    },
    [terminalRef, onTerminalReady],
  );

  const hasWarning = deploymentStatus === "ready" && !!state.warningMessage;

  return (
    <PageContainer>
      <DeploymentHeader onRedeploy={onRedeploy} />
      <DeploymentLayout details={<DeploymentDetails />} navigation={<DeploymentStepper />}>
        {hasWarning && (
          <div className="rounded-2xl border border-warning-border bg-warning-bg px-4 py-3">
            <p className="text-sm font-medium text-warning">{dp.warningTitle}</p>
            <p className="mt-1 text-sm text-warning">{state.warningMessage}</p>
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

        <DeploymentLogsPanel
          title={t.importProject.composeDeployment.logsTitle}
          summary={
            deploymentStatus === "failed" && (
              <span className="text-sm text-muted-foreground">{dp.seeLogs}</span>
            )
          }
        >
          <BuildTerminal
            onReady={handleTerminalReady}
            theme={resolvedTheme === "light" ? "light" : "dark"}
          />
        </DeploymentLogsPanel>
      </DeploymentLayout>
    </PageContainer>
  );
};

export default DeploymentProcessing;
