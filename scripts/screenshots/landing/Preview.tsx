"use client";

import { useCallback, useEffect, useState } from "react";
import { AuthProvider } from "@/context/AuthContext";
import { PlatformProvider } from "@/context/PlatformContext";
import { GitHubProvider } from "@/context/GitHubContext";
import { CloudProvider } from "@/context/CloudContext";
import { DeploymentContext } from "@/context/DeploymentContext";
import { INITIAL_STATE, type DeploymentConfig } from "@/context/deployment/types";
import { DashboardShell } from "@/components/dashboard-shell";
import { PageContainer } from "@/components/ui/PageContainer";
import ProjectSettings from "@/components/import-project/ProjectSettings";
import BuildSettings from "@/components/import-project/BuildSettings";
import EnvironmentVariables from "@/components/import-project/EnvironmentVariables";
import DeploySidebar from "@/app/(dashboard)/(deployment)/deploy/[slug]/components/Sidebar";
import { captureConfig, deployment } from "./fixture";

// Mounted only in the capture script's temporary, development-only route.
// This is the real shell and wizard; names and configuration are sample data.
export const captureUser = {
  id: "screenshot-user",
  name: "Alex Morgan",
  email: "alex@example.com",
  emailVerified: true,
};

export default function Preview() {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const [config, setConfig] = useState<DeploymentConfig>(() => {
    const initial = structuredClone(captureConfig);
    initial.options.outputDirectory = "";
    return initial;
  });
  const updateConfig = useCallback((next: Partial<DeploymentConfig>) => {
    setConfig((previous) => ({ ...previous, ...next }));
  }, []);
  const updateOptions = useCallback((next: Partial<DeploymentConfig["options"]>) => {
    setConfig((previous) => ({ ...previous, options: { ...previous.options, ...next } }));
  }, []);
  const value = {
    ...deployment(false, config),
    state: { ...INITIAL_STATE },
    updateConfig,
    updateOptions,
  };

  return (
    <AuthProvider initialUser={captureUser}>
      <PlatformProvider
        selfHosted
        deployMode="desktop"
        authMode="none"
        hostDomain="opsh.io"
        machineName="Studio Mac"
      >
        <GitHubProvider>
          <CloudProvider>
            <DeploymentContext.Provider value={value}>
              <div
                className="flex h-dvh flex-col bg-background text-foreground"
                data-landing-capture
                data-capture-ready={ready}
              >
                <DashboardShell>
                  <PageContainer className="py-4">
                    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
                      <div className="min-w-0 space-y-3" data-capture-configuration>
                        <div data-capture-framework>
                          <ProjectSettings />
                        </div>
                        <div data-capture-build>
                          <BuildSettings />
                        </div>
                        <div data-capture-environment>
                          <EnvironmentVariables collapsible isEditingMode={false} />
                        </div>
                      </div>
                      <DeploySidebar destinationReady />
                    </div>
                  </PageContainer>
                </DashboardShell>
              </div>
            </DeploymentContext.Provider>
          </CloudProvider>
        </GitHubProvider>
      </PlatformProvider>
    </AuthProvider>
  );
}
