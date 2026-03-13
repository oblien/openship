"use client";

import { DeploymentProvider } from "@/context/DeploymentContext";

export default function DeploymentLayout({ children }: { children: React.ReactNode }) {
  return <DeploymentProvider>{children}</DeploymentProvider>;
}
