"use client";

import React, { createContext, useContext } from "react";
import { CLOUD_DASHBOARD_URL } from "@repo/core";

interface OnboardingContextValue {
  authMode: "cloud" | "local" | "none";
  cloudAuthUrl: string;
  selfHosted: boolean;
  deployMode: string;
}

const OnboardingContext = createContext<OnboardingContextValue>({
  authMode: "none",
  cloudAuthUrl: CLOUD_DASHBOARD_URL,
  selfHosted: true,
  deployMode: "docker",
});

export function useOnboardingContext() {
  return useContext(OnboardingContext);
}

export function OnboardingProviders({
  children,
  authMode,
  cloudAuthUrl,
  selfHosted,
  deployMode,
}: {
  children: React.ReactNode;
  authMode: "cloud" | "local" | "none";
  cloudAuthUrl: string;
  selfHosted: boolean;
  deployMode: string;
}) {
  return (
    <OnboardingContext.Provider value={{ authMode, cloudAuthUrl, selfHosted, deployMode }}>
      {children}
    </OnboardingContext.Provider>
  );
}
