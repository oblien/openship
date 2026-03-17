"use client";

import { GitHubProvider } from "@/context/GitHubContext";
import { CloudProvider } from "@/context/CloudContext";

interface DashboardProvidersProps {
  children: React.ReactNode;
  selfHosted: boolean;
  deployMode: string;
  authMode: "cloud" | "local" | "none";
  cloudAuthUrl: string;
  machineName?: string;
}

export function DashboardProviders({ children, selfHosted, deployMode, authMode, cloudAuthUrl, machineName }: DashboardProvidersProps) {
  return (
    <GitHubProvider initialSelfHosted={selfHosted} initialDeployMode={deployMode} initialAuthMode={authMode} initialCloudAuthUrl={cloudAuthUrl} initialMachineName={machineName}>
      <CloudProvider>
        {children}
      </CloudProvider>
    </GitHubProvider>
  );
}
