"use client";

import React, { createContext, useContext } from "react";
import {
  CLOUD_DASHBOARD_URL,
  OPERATOR_FEATURES,
  type EditionFeatures,
} from "@repo/core";

interface AuthContextValue {
  authMode: "cloud" | "local" | "none";
  cloudAuthUrl: string;
  selfHosted: boolean;
  features: EditionFeatures;
}

const AuthContext = createContext<AuthContextValue>({
  authMode: "local",
  cloudAuthUrl: CLOUD_DASHBOARD_URL,
  selfHosted: true,
  features: OPERATOR_FEATURES,
});

export function useAuthContext() {
  return useContext(AuthContext);
}

interface AuthProvidersProps {
  children: React.ReactNode;
  authMode: "cloud" | "local" | "none";
  cloudAuthUrl: string;
  selfHosted: boolean;
  features?: EditionFeatures;
}

export function AuthProviders({
  children,
  authMode,
  cloudAuthUrl,
  selfHosted,
  features = OPERATOR_FEATURES,
}: AuthProvidersProps) {
  return (
    <AuthContext.Provider value={{ authMode, cloudAuthUrl, selfHosted, features }}>
      {children}
    </AuthContext.Provider>
  );
}
