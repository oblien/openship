"use client";

import { GitHubProvider } from "@/context/GitHubContext";

export function DashboardProviders({ children }: { children: React.ReactNode }) {
  return <GitHubProvider>{children}</GitHubProvider>;
}
