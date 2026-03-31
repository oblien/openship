"use client";

import React, { createContext, useContext } from "react";

interface OnboardingContextValue {
  authMode: "cloud" | "local" | "none";
  cloudAuthUrl: string;
  selfHosted: boolean;
}

const OnboardingContext = createContext<OnboardingContextValue>({
  authMode: "none",
  cloudAuthUrl: "",
  selfHosted: true,
});

export function useOnboardingContext() {
  return useContext(OnboardingContext);
}

export function OnboardingProviders({
  children,
  authMode,
  cloudAuthUrl,
  selfHosted,
}: {
  children: React.ReactNode;
  authMode: "cloud" | "local" | "none";
  cloudAuthUrl: string;
  selfHosted: boolean;
}) {
  return (
    <OnboardingContext.Provider value={{ authMode, cloudAuthUrl, selfHosted }}>
      {children}
    </OnboardingContext.Provider>
  );
}
