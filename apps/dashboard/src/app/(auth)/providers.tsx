"use client";

import React, { createContext, useContext } from "react";
import { CLOUD_DASHBOARD_URL } from "@repo/onboarding";

interface AuthContextValue {
  authMode: "cloud" | "local" | "none";
  cloudAuthUrl: string;
  selfHosted: boolean;
}

const AuthContext = createContext<AuthContextValue>({
  authMode: "local",
  cloudAuthUrl: CLOUD_DASHBOARD_URL,
  selfHosted: true,
});

export function useAuthContext() {
  return useContext(AuthContext);
}

interface AuthProvidersProps {
  children: React.ReactNode;
  authMode: "cloud" | "local" | "none";
  cloudAuthUrl: string;
  selfHosted: boolean;
}

export function AuthProviders({ children, authMode, cloudAuthUrl, selfHosted }: AuthProvidersProps) {
  return (
    <AuthContext.Provider value={{ authMode, cloudAuthUrl, selfHosted }}>
      {children}
    </AuthContext.Provider>
  );
}
