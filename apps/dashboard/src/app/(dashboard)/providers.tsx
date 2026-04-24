"use client";

import { GitHubProvider } from "@/context/GitHubContext";
import { CloudProvider } from "@/context/CloudContext";
import { PlatformProvider } from "@/context/PlatformContext";

interface DashboardProvidersProps {
  children: React.ReactNode;
  selfHosted: boolean;
  deployMode: string;
  authMode: "cloud" | "local" | "none";
  cloudAuthUrl: string;
  machineName?: string;
  hostDomain?: string;
  initialGithubData?: any;
}

export function DashboardProviders({ children, initialGithubData, selfHosted, deployMode, authMode, cloudAuthUrl, machineName, hostDomain }: DashboardProvidersProps) {
  return (
    <PlatformProvider selfHosted={selfHosted} deployMode={deployMode} authMode={authMode} cloudAuthUrl={cloudAuthUrl} machineName={machineName} hostDomain={hostDomain}>
      <GitHubProvider initialData={initialGithubData}>
        <CloudProvider>
          {children}
        </CloudProvider>
      </GitHubProvider>
    </PlatformProvider>
  );
}
