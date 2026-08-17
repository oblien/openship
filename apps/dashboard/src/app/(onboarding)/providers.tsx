"use client";

import React, { createContext, useContext } from "react";
import {
  CLOUD_DASHBOARD_URL,
  OPERATOR_FEATURES,
  type EditionFeatures,
} from "@repo/core";

interface OnboardingContextValue {
  authMode: "cloud" | "local" | "none";
  cloudAuthUrl: string;
  selfHosted: boolean;
  deployMode: string;
  features: EditionFeatures;
}

const OnboardingContext = createContext<OnboardingContextValue>({
  authMode: "none",
  cloudAuthUrl: CLOUD_DASHBOARD_URL,
  selfHosted: true,
  deployMode: "docker",
  features: OPERATOR_FEATURES,
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
  features = OPERATOR_FEATURES,
}: {
  children: React.ReactNode;
  authMode: "cloud" | "local" | "none";
  cloudAuthUrl: string;
  selfHosted: boolean;
  deployMode: string;
  features?: EditionFeatures;
}) {
  return (
    <OnboardingContext.Provider value={{ authMode, cloudAuthUrl, selfHosted, deployMode, features }}>
      {children}
    </OnboardingContext.Provider>
  );
}
