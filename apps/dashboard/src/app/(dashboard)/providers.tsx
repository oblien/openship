"use client";

import { GitHubProvider } from "@/context/GitHubContext";

interface DashboardProvidersProps {
  children: React.ReactNode;
  selfHosted: boolean;
  deployMode: string;
}

export function DashboardProviders({ children, selfHosted, deployMode }: DashboardProvidersProps) {
  return (
    <GitHubProvider initialSelfHosted={selfHosted} initialDeployMode={deployMode}>
      {children}
    </GitHubProvider>
  );
}
