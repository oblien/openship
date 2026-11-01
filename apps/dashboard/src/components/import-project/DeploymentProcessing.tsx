"use client";

import React, { useCallback } from "react";
import type { Terminal } from "@xterm/xterm";
import { CloudBuildQueueNotice } from "./CloudBuildQueueNotice";
import { CloudDeploymentResourceNotice } from "./CloudDeploymentResourceNotice";
import BuildTerminal from "./BuildTerminal";
import { DeploymentHeader } from "./DeploymentHeader";
import { DeploymentLayout } from "./DeploymentLayout";
import { DeploymentLogsPanel } from "./DeploymentLogsPanel";
import DeploymentDetails from "./DeploymentDetails";
import { DeploymentStepper } from "./DeploymentStepper";
import { PageContainer } from "@/components/ui/PageContainer";
import { PortAdvisoryModal } from "./PortAdvisoryModal";
import { useDeploymentPrompt } from "./useDeploymentPrompt";
import { useDeployment } from "@/context/DeploymentContext";
import { useTheme } from "@/components/theme-provider";
import { useI18n } from "@/components/i18n-provider";

interface DeploymentProcessingProps {
  // Resolves to the new deployment id (navigates on success) or null on failure.
  onRedeploy: (options?: { reuseBuild?: boolean }) => void | Promise<string | null>;
}

const DeploymentProcessing: React.FC<DeploymentProcessingProps> = ({ onRedeploy }) => {
  const {
    config,
    state,
    terminalRef,
    onTerminalReady,
    respondToPrompt,
    resolvePortCheck,
    deploymentStatus,
  } = useDeployment();
  const { resolvedTheme } = useTheme();
  const { t } = useI18n();
  const dp = t.importProject.deploymentProcessing;
  useDeploymentPrompt(
    ["ready", "failed", "cancelled"].includes(deploymentStatus) ? null : state.pendingPrompt,
    respondToPrompt,
  );

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
      <DeploymentLayout
        details={<DeploymentDetails />}
        navigation={<DeploymentStepper />}
        notice={<CloudDeploymentResourceNotice />}
      >
        {state.queue && state.isDeploying && <CloudBuildQueueNotice queue={state.queue} />}
        {hasWarning && (
          <div className="rounded-2xl border border-warning-border bg-warning-bg px-4 py-3">
            <p className="text-sm font-medium text-warning">{dp.warningTitle}</p>
            <p className="mt-1 text-sm text-warning">{state.warningMessage}</p>
          </div>
        )}

        {deploymentStatus === "ready" && (
          <PortAdvisoryModal
            key={state.deploymentId}
            deploymentId={state.deploymentId}
            projectId={state.projectId ?? config.projectId}
            checks={state.portCheck}
            skipped={state.portCheckSkipped}
            isCompose={false}
            onResolved={resolvePortCheck}
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
