"use client";

import React, { createContext, useContext } from "react";
import { CLOUD_DASHBOARD_URL } from "@repo/core";

interface AuthContextValue {
  authMode: "cloud" | "local" | "none";
  cloudAuthUrl: string;
  selfHosted: boolean;
  /** Empty user table — show first-admin register link on self-host (#138). */
  bootstrapRequired: boolean;
}

const AuthContext = createContext<AuthContextValue>({
  authMode: "local",
  cloudAuthUrl: CLOUD_DASHBOARD_URL,
  selfHosted: true,
  bootstrapRequired: false,
});

export function useAuthContext() {
  return useContext(AuthContext);
}

interface AuthProvidersProps {
  children: React.ReactNode;
  authMode: "cloud" | "local" | "none";
  cloudAuthUrl: string;
  selfHosted: boolean;
  bootstrapRequired?: boolean;
}

export function AuthProviders({
  children,
  authMode,
  cloudAuthUrl,
  selfHosted,
  bootstrapRequired = false,
}: AuthProvidersProps) {
  return (
    <AuthContext.Provider value={{ authMode, cloudAuthUrl, selfHosted, bootstrapRequired }}>
      {children}
    </AuthContext.Provider>
  );
}
