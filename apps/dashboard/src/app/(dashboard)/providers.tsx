"use client";

import { GitHubProvider } from "@/context/GitHubContext";
import { CloudProvider } from "@/context/CloudContext";
import { PlatformProvider } from "@/context/PlatformContext";
import { AuthProvider, type AuthUser } from "@/context/AuthContext";

interface DashboardProvidersProps {
  children: React.ReactNode;
  selfHosted: boolean;
  deployMode: string;
  authMode: "cloud" | "local" | "none";
  cloudAuthUrl: string;
  machineName?: string;
  hostDomain?: string;
  initialUser?: AuthUser | null;
  initialGithubData?: any;
}

export function DashboardProviders({
  children,
  initialGithubData,
  initialUser,
  selfHosted,
  deployMode,
  authMode,
  cloudAuthUrl,
  machineName,
  hostDomain,
}: DashboardProvidersProps) {
  return (
    <AuthProvider initialUser={initialUser}>
      <PlatformProvider
        selfHosted={selfHosted}
        deployMode={deployMode}
        authMode={authMode}
        cloudAuthUrl={cloudAuthUrl}
        machineName={machineName}
        hostDomain={hostDomain}
      >
        <GitHubProvider initialData={initialGithubData}>
          <CloudProvider>
            {children}
          </CloudProvider>
        </GitHubProvider>
      </PlatformProvider>
    </AuthProvider>
  );
}
