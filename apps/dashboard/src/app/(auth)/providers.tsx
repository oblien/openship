"use client";

import React, { createContext, useContext } from "react";
import { CLOUD_DASHBOARD_URL } from "@repo/core";
import type { AdvertisedAuthProvider } from "@/lib/auth-providers";

interface AuthContextValue {
  authMode: "cloud" | "local" | "none";
  cloudAuthUrl: string;
  selfHosted: boolean;
  /** Social logins the API advertises as configured (GET /health/env). The
   *  login/register pages render exactly these; empty means password only. */
  authProviders: AdvertisedAuthProvider[];
}

const AuthContext = createContext<AuthContextValue>({
  authMode: "local",
  cloudAuthUrl: CLOUD_DASHBOARD_URL,
  selfHosted: true,
  // Default to "none advertised": showing a button that isn't configured is a
  // dead end, showing none is merely password login.
  authProviders: [],
});

export function useAuthContext() {
  return useContext(AuthContext);
}

interface AuthProvidersProps {
  children: React.ReactNode;
  authMode: "cloud" | "local" | "none";
  cloudAuthUrl: string;
  selfHosted: boolean;
  authProviders?: AdvertisedAuthProvider[];
}

export function AuthProviders({
  children,
  authMode,
  cloudAuthUrl,
  selfHosted,
  authProviders = [],
}: AuthProvidersProps) {
  return (
    <AuthContext.Provider value={{ authMode, cloudAuthUrl, selfHosted, authProviders }}>
      {children}
    </AuthContext.Provider>
  );
}
